/**
 * Feishu <-> DeepSeek Harness routing.
 *
 * Inbound: one bot long-connection consumer delivers `im.message.receive_v1`.
 * A conversation (p2p chat, or one group thread) binds to exactly one DSH
 * Session; the prompt is admitted through `sessionController` so the Session is
 * an ordinary Harness Session with a normal durable log.
 *
 * Outbound: durable `session/event` frames of bound Sessions are mirrored back
 * to the originating conversation, so both sides keep the same transcript.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { chunkText, errorText, formatElapsed, textOfMessage } from './util.js'

const HELP = [
  '🤖 DeepSeek Harness 飞书桥接',
  '',
  '直接发消息 = 交给 DSH 会话执行。',
  '',
  '/new          新建一个 DSH 会话',
  '/stop         停止当前任务',
  '/approve      批准待处理的工具授权（仅本次）',
  '/reject       拒绝待处理的工具授权',
  '/status       查看当前会话状态',
  '/doctor       自检：应用、通道、白名单、绑定',
  '/model        查看当前模型；/model <provider>/<model> [effort] 切换（provider 可含空格）',
  '/models       列出可用模型',
  '/title <文本> 给当前会话改名',
  '/cwd          查看工作目录',
  '/sessions     列出最近的会话',
  '/resume <id>  绑定到指定会话',
  '/help         显示本帮助',
].join('\n')

export class FeishuBridge {
  constructor({ ctx, config, store, lark, log }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.lark = lark
    this.log = log
    this.seen = new Set()
    this.turns = new Map()
    this.sessions = new Map()
    /** sessionId -> pending approval entries, oldest first. */
    this.pending = new Map()
    /** sessionId -> the one question currently being asked. */
    this.questions = new Map()
    /** card id -> conversation, kept past expiry so a late click can be answered. */
    this.cardChats = new Map()
    /** Observability: cheap counters the diagnostics view reports. */
    this.startedAt = Date.now()
    this.lastInboundAt = 0
    this.lastInboundFrom = ''
    this.inboundCount = 0
    this.outboundFailures = 0
  }

  /** Snapshot of everything `/doctor` and the config page's status block show. */
  diagnostics() {
    return {
      appId: this.identity?.appId,
      workspace: this.identity?.workspace,
      cwd: this.config.cwd,
      allowList: this.config.allowOpenIds.length,
      identity: this.config.identity,
      channels: this.lark.health(),
      bindings: this.sessions.size,
      pendingApprovals: [...this.pending.values()].reduce((total, list) => total + list.length, 0),
      pendingQuestion: this.questions.size,
      inboundCount: this.inboundCount,
      lastInboundAt: this.lastInboundAt || null,
      lastInboundFrom: this.lastInboundFrom || null,
      outboundFailures: this.outboundFailures,
      uptimeMs: Date.now() - this.startedAt,
      cardButtons: this.config.cardButtons !== false,
      feishuApprovals: this.config.feishuApprovals !== false,
      feishuQuestions: this.config.feishuQuestions !== false,
    }
  }

  async start() {
    for (const entry of this.store.list()) {
      if (entry.sessionId) this.sessions.set(entry.sessionId, entry.chat ?? {})
    }
    await this.ensureWorkspace()
    this.lark.startConsume((payload, key) => {
      if (key === 'card.action.trigger' || payload?.type === 'card.action.trigger') {
        this.onCardAction(payload).catch((error) => this.log('feishu.card.failed', errorText(error), 'error'))
        return
      }
      this.onFeishuEvent(payload).catch((error) => {
        this.log('feishu.event.failed', errorText(error), 'error')
      })
    })
    this.log('bridge.started', JSON.stringify({ cwd: this.config.cwd, bindings: this.sessions.size }))
    // Identity is a CLI round trip; fetch it after the consumers are up so a
    // slow `config show` cannot delay inbound delivery. `onboard()` awaits this
    // same promise instead of racing it.
    this.identityPromise = this.lark
      .describeIdentity()
      .then((identity) => {
        this.identity = identity
        this.log('bridge.identity', JSON.stringify(identity ?? null))
        return identity
      })
      .catch(() => undefined)
  }

  async stop() {
    this.cancelAllApprovals('bridge stopped')
    await this.lark.stop()
    this.log('bridge.stopped')
  }

  // --------------------------------------------------------------- onboarding

  /**
   * First-run guidance, sent once per bound application. A changed App ID means
   * the CLI was switched to another Feishu account, so the guidance repeats —
   * which is exactly when the user needs it again.
   */
  async onboard() {
    if (this.config.welcome === false) return
    if (this.config.allowOpenIds.length === 0) {
      this.log('welcome.skipped', 'allowlist empty: nobody to greet, and nobody can drive the bridge')
      return
    }
    // Wait for the concurrent identity fetch rather than stamping a placeholder
    // app id (which would re-send the guidance forever).
    const identity = this.identity ?? (await (this.identityPromise ?? Promise.resolve(undefined)))
    const stamp = identity?.appId
    if (!stamp) {
      this.log('welcome.deferred', 'application identity unknown; guidance not sent')
      return
    }
    const markerFile = path.join(this.config.stateDir, 'welcome.json')
    let marker
    try {
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
    } catch {
      marker = undefined
    }
    if (marker && marker.appId === stamp) return

    const text = this.welcomeText()
    let sent = 0
    for (const openId of this.config.allowOpenIds) {
      try {
        await this.send({ openId, chatType: 'p2p' }, text)
        sent += 1
      } catch (error) {
        this.log('welcome.send.failed', `${openId} ${errorText(error)}`, 'warn')
      }
    }
    if (sent > 0) {
      try {
        fs.mkdirSync(this.config.stateDir, { recursive: true })
        fs.writeFileSync(markerFile, `${JSON.stringify({ appId: stamp, sentAt: Date.now(), sent }, null, 2)}\n`, { mode: 0o600 })
        this.log('welcome.sent', `${stamp} to ${sent} chat(s)`)
      } catch (error) {
        this.log('welcome.marker.failed', errorText(error), 'warn')
      }
    }
  }

  welcomeText() {
    const health = this.lark.health()
    const marks = { ready: '✅', disabled: '❌', starting: '⏳', restarting: '⏳', unknown: '❔' }
    const label = (key) => (key === 'im.message.receive_v1' ? '消息接收' : key === 'card.action.trigger' ? '卡片按钮' : key)
    const lines = [
      '🤖 **DeepSeek Harness ↔ 飞书桥接已就绪**',
      '',
      `应用：\`${this.identity?.appId ?? '未知'}\`${this.identity?.workspace ? `（workspace：${this.identity.workspace}）` : ''}`,
      `工作目录：\`${this.config.cwd}\``,
      `白名单：${this.config.allowOpenIds.length} 人`,
      '事件通道：',
      ...health.map((item) => `　${marks[item.state] ?? '❔'} ${label(item.key)}（${item.state}）`),
      '',
      '**怎么用**',
      '· 直接发消息 = 交给 DSH 会话执行（会在 DSH 侧生成同名会话）',
      '· `/help` 全部指令 · `/new` 新会话 · `/status` 状态 · `/stop` 停 · `/sessions` 列表',
      '· 需要授权时：点卡片按钮，或回 `1` 允许 / `2` 拒绝',
      '· 需要你选择时：点按钮，或回序号（多选 `1,3`），也可直接回文字',
      '',
      '**建议先做两步**',
      '1. 发 `/status`，确认绑定与通道健康',
      '2. 发一句真实任务，例如「看一下当前目录有哪些文件」',
    ]
    const card = health.find((item) => item.key === 'card.action.trigger')
    if (card && card.state !== 'ready') {
      lines.push('')
      lines.push('⚠️ 卡片按钮当前不可用：到开放平台给该应用订阅回调 `card.action.trigger` 并发布版本，然后重载插件。期间用数字回复即可。')
    }
    const message = health.find((item) => item.key === 'im.message.receive_v1')
    if (message && message.state !== 'ready') {
      lines.push('')
      lines.push('⚠️ 消息通道还没 ready：确认应用已发布、事件订阅方式为长连接，并已订阅 `im.message.receive_v1`。')
    }
    lines.push('')
    lines.push('改配置：DSH → 插件 → 飞书远程桥接 → 配置（工作目录、白名单、群聊粒度、授权与提问开关）')
    return lines.join('\n')
  }

  /** Sessions live under one dedicated workspace so they stay visible in the Web UI. */
  async ensureWorkspace() {
    if (this.config.workspaceId) return this.config.workspaceId
    const registry = this.ctx.get?.('workspaceRegistry') ?? this.ctx.workspaceRegistry
    if (!registry || typeof registry.create !== 'function') return undefined
    try {
      const existing = registry
        .list()
        .find((workspace) => workspace.path === this.config.cwd)
      const workspace = existing ?? (await registry.create(this.config.cwd, this.config.workspaceTitle))
      this.config.workspaceId = workspace.id
      this.log('bridge.workspace', `${workspace.id} ${workspace.path}`)
      return workspace.id
    } catch (error) {
      this.log('bridge.workspace.failed', errorText(error), 'warn')
      return undefined
    }
  }

  // ---------------------------------------------------------------- inbound

  async onFeishuEvent(payload) {
    if (!payload || payload.type !== 'im.message.receive_v1') return
    if (payload.sender_type !== 'user') return
    const messageId = payload.message_id ?? payload.id
    if (!messageId) return
    if (this.seen.has(messageId)) return
    this.remember(messageId)

    const openId = payload.sender_id
    // One line per delivered message: a message that reuses an existing Session
    // otherwise leaves no trace, and "never delivered" could not be told apart
    // from "delivered and rejected".
    this.log(
      'feishu.inbound',
      JSON.stringify({
        chat: payload.chat_type,
        type: payload.message_type,
        mentions: Array.isArray(payload.mentions) ? payload.mentions.length : 0,
        from: openId ? String(openId).slice(0, 14) : null,
        len: String(payload.content ?? '').length,
      }),
    )
    if (this.config.allowOpenIds.length === 0) {
      // Deny by default: an empty allowlist must never mean "anyone may drive this machine".
      this.log('feishu.rejected-unpaired', `sender=${openId ?? 'unknown'} chat=${payload.chat_id ?? 'unknown'}`)
      await this.replyUnpaired(payload, openId)
      return
    }
    if (!this.config.allowOpenIds.includes(openId)) {
      this.log('feishu.rejected-sender', String(openId ?? 'unknown'))
      await this.replyUnpaired(payload, openId)
      return
    }

    const chat = {
      chatId: payload.chat_id,
      chatType: payload.chat_type,
      threadId: payload.thread_id ?? null,
      rootId: payload.root_id ?? null,
      messageId,
    }
    this.inboundCount += 1
    this.lastInboundAt = Date.now()
    this.lastInboundFrom = openId ?? ''
    const isGroup = payload.chat_type === 'group'
    const mentions = Array.isArray(payload.mentions) ? payload.mentions : []
    if (isGroup && this.config.groupRequiresMention && mentions.length === 0) {
      this.log('feishu.group.skipped', 'group message without a mention')
      return
    }

    const text = String(payload.content ?? '')
      .replace(/@_user_\d+/g, '')
      .trim()

    // Feishu renders attachments as markers inside `content`
    // (`[Image: img_x]`, `![Image](img_x)`, `<file key="file_x" …/>`).
    const { images, files, stickers, cleaned } = collectResources(text, payload.message_type)
    if (images.length > 0 || files.length > 0) {
      this.log('feishu.attachment.detected', JSON.stringify({ images: images.length, files: files.length, type: payload.message_type }))
      if (this.config.attachments === false) {
        await this.send(chat, '当前配置关闭了附件接收，请发送文本。')
        return
      }
      await this.forwardAttachments(chat, cleaned, images, files, payload)
      return
    }
    if (stickers > 0) {
      await this.send(chat, '表情包/贴纸收不到内容，麻烦发图片文件。')
      return
    }

    if (!text) {
      await this.send(chat, '目前只支持文本、图片与文件。')
      return
    }
    const messageType = payload.message_type
    if (messageType && messageType !== 'text' && messageType !== 'post') {
      this.log(
        'feishu.unsupported-message',
        JSON.stringify({ type: messageType, content: String(payload.content ?? '').slice(0, 400) }),
      )
      await this.send(chat, `暂不支持 ${messageType} 类型消息，请发送文本、图片或文件。`)
      return
    }

    const command = /^\/([a-zA-Z]+)\s*([\s\S]*)$/.exec(cleaned)
    if (command) {
      const verb = command[1].toLowerCase()
      try {
        await this.onCommand(chat, verb, command[2].trim())
      } catch (error) {
        // A command must always answer, even when a service access fails.
        this.log('bridge.command.failed', `${verb} ${errorText(error)}`, 'error')
        await this.send(chat, `⚠️ 指令 /${verb} 执行失败：${errorText(error)}`).catch(() => {})
      }
      return
    }

    // A pending question or approval owns the next reply: a bare "1" must answer
    // it rather than start a new model turn.
    if (await this.consumePendingReply(chat, cleaned)) return
    await this.forward(chat, cleaned)
  }

  /**
   * Download the message's attachments and hand them to the Session: images ride
   * the prompt as image parts, everything else is saved and referenced by path
   * so the agent can open it with its own tools.
   */
  async forwardAttachments(chat, text, images, files, payload) {
    const key = this.routeKey(chat)
    let entry = this.store.get(key)
    const messageId = payload.message_id ?? payload.id
    const directory = path.join(this.config.stateDir, 'incoming', String(messageId ?? `m${Date.now()}`))
    try {
      fs.mkdirSync(directory, { recursive: true })
    } catch (error) {
      this.log('feishu.attachment.dir.failed', errorText(error), 'error')
    }

    await this.acknowledge(chat)
    let sessionId = entry?.sessionId

    const parts = []
    const saved = []
    for (const imageKey of images.slice(0, 4)) {
      try {
        const downloaded = await this.lark.downloadResource(messageId, imageKey, 'image', directory)
        const bytes = fs.readFileSync(downloaded.path)
        saved.push(downloaded.path)
        const mediaType = mediaTypeOf(downloaded.path)
        if (bytes.length > 18 * 1024 * 1024) {
          this.log('feishu.attachment.too-large', `${downloaded.path} ${bytes.length}`)
          continue
        }
        parts.push({ type: 'image', mediaType, data: bytes.toString('base64'), name: path.basename(downloaded.path) })
      } catch (error) {
        this.log('feishu.attachment.image.failed', `${imageKey} ${errorText(error)}`, 'warn')
      }
    }
    for (const file of files.slice(0, 4)) {
      try {
        const downloaded = await this.lark.downloadResource(messageId, file.key, 'file', directory)
        saved.push(downloaded.path)
      } catch (error) {
        this.log('feishu.attachment.file.failed', `${file.key} ${errorText(error)}`, 'warn')
      }
    }

    if (parts.length === 0 && saved.length === 0) {
      await this.send(chat, '收到附件但没能下载，可能是应用缺少 `im:message:readonly` / `im:resource` 权限。')
      return
    }

    // Create the Session only now: a failure above must not leave a blank
    // Session behind (the sidebar hides those, which looks like data loss).
    if (!sessionId) {
      sessionId = await this.createSession(key, chat)
    } else {
      this.sessions.set(sessionId, entry.chat ?? chat)
    }

    const lines = []
    if (text) lines.push(text)
    else lines.push(images.length > 0 ? '用户发来图片（见附件）。' : '用户发来文件。')
    if (saved.length > 0) {
      lines.push('', '已保存到本机：')
      for (const item of saved.slice(0, 8)) lines.push(`· ${item}`)
    }
    parts.unshift({ type: 'text', text: lines.join('\n') })

    this.turns.set(sessionId, { chat, key, startedAt: Date.now() })
    try {
      await this.ctx.sessionController.prompt(
        { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: parts },
        new AbortController().signal,
      )
      this.log('feishu.attachment.forwarded', `${sessionId} images=${images.length} files=${files.length}`)
    } catch (error) {
      // A text-only model refuses image parts at admission. The bytes are already
      // on disk, so fall back to a text prompt that points at them.
      const message = errorText(error)
      this.turns.delete(sessionId)
      if (parts.some((part) => part.type === 'image') || saved.length > 0) {
        this.log('feishu.attachment.fallback', `${sessionId} ${message}`)
        await this.forwardAttachmentsAsPaths(chat, sessionId, key, text, saved, message, images.length, files.length)
        return
      }
      this.discardSessionIfBlank(key, sessionId)
      this.log('feishu.attachment.prompt.failed', message, 'error')
      await this.send(chat, `⚠️ 无法把附件交给会话：${message}`)
    }
  }

  /** A Session created for a prompt that never landed should not linger as a blank row. */
  discardSessionIfBlank(key, sessionId) {
    try {
      const entry = this.store.get(key)
      if (entry && entry.sessionId === sessionId) {
        this.store.remove(key)
        this.sessions.delete(sessionId)
        this.log('bridge.session.discarded', `${sessionId} (blank, prompt never landed)`)
      }
    } catch (error) {
      this.log('bridge.session.discard.failed', errorText(error), 'warn')
    }
  }

  /** Fallback for models without image input: describe the saved files by path. */
  async forwardAttachmentsAsPaths(chat, sessionId, key, text, saved, reason, imageCount, fileCount) {
    const lines = []
    if (text) lines.push(text)
    if (imageCount > 0 && saved.length > 0) {
      lines.push('', `用户发来 ${imageCount} 张图片，已保存到本机（当前模型不支持直接看图）：`)
      for (const item of saved.slice(0, 8)) lines.push(`· ${item}`)
      lines.push('', '请读取这些文件来了解图片内容。')
    } else if (saved.length > 0) {
      lines.push('', '用户发来的文件已保存到本机：')
      for (const item of saved.slice(0, 8)) lines.push(`· ${item}`)
    } else {
      lines.push('', '附件未能保存。')
    }
    this.turns.set(sessionId, { chat, key, startedAt: Date.now() })
    try {
      await this.ctx.sessionController.prompt(
        { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: lines.join('\n') }] },
        new AbortController().signal,
      )
      this.log('feishu.attachment.forwarded', `${sessionId} images=${imageCount} files=${fileCount} (路径模式：${reason.slice(0, 60)})`)
    } catch (error) {
      this.turns.delete(sessionId)
      this.log('feishu.attachment.prompt.failed', errorText(error), 'error')
      await this.send(chat, `⚠️ 无法把附件交给会话：${errorText(error)}`)
    }
  }

  /** Route one reply to whatever this conversation is currently waiting on. */
  async consumePendingReply(chat, text) {
    const entry = this.store.get(this.routeKey(chat))
    const sessionId = entry?.sessionId
    if (!sessionId) return false

    if (await this.answerPendingQuestion(sessionId, text)) return true

    const pending = this.pending.get(sessionId)
    if (pending && pending.length > 0) {
      const decision = text.trim().toLowerCase()
      const approve = ['1', 'y', 'yes', 'ok', '同意', '允许', '批准', '可以'].includes(decision)
      const reject = ['2', 'n', 'no', '拒绝', '不行', '取消', '不要'].includes(decision)
      if (approve || reject) {
        await this.decideApprovals(chat, approve ? 'allowed-once' : 'rejected')
        return true
      }
    }
    return false
  }

  /** Tell a stranger what to do — direct chats only, and it names the exact value to add. */
  async replyUnpaired(payload, openId) {
    if (payload.chat_type !== 'p2p') return
    if (this.config.unpairedReply === false) return
    const lines = [
      '🔒 这台机器上的 DSH 桥接还没授权你。',
      '',
      '把下面这行加进插件白名单（DSH → 插件 → 飞书远程桥接 → 配置）：',
      `\`${openId ?? 'ou_xxx'}\``,
      '',
      '保存后立即生效，不用重启。',
    ].join('\n')
    await this.send(
      {
        chatId: payload.chat_id,
        chatType: 'p2p',
        threadId: payload.thread_id ?? null,
        rootId: payload.root_id ?? null,
      },
      lines,
    ).catch((error) => this.log('feishu.unpaired-reply.failed', errorText(error), 'warn'))
  }

  remember(messageId) {    this.seen.add(messageId)
    if (this.seen.size > 4000) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
  }

  /**
   * One DSH Session per conversation:
   * - p2p chat: always the same Session;
   * - group: stable per chat, or per topic when the message carries a thread id.
   * Only `thread_id` scopes a conversation. `root_id` is a per-message reply
   * context inside the same conversation, and a group message with neither must
   * NOT fall back to its message id — otherwise every @bot message starts a new
   * Session and replies to the bot fork yet another one.
   */
  routeKey(chat) {
    if (chat.chatType !== 'group') return `p2p:${chat.chatId}`
    if (this.config.groupSessions === 'chat') return `group:${chat.chatId}`
    return `group:${chat.chatId}:${chat.threadId ?? ''}`
  }

  async forward(chat, text) {
    const key = this.routeKey(chat)
    let entry = this.store.get(key)
    if (!entry?.sessionId) {
      await this.acknowledge(chat)
      const sessionId = await this.createSession(key, chat)
      await this.prompt(sessionId, chat, key, text)
      void this.titleSession(sessionId, text)
      return
    }
    this.sessions.set(entry.sessionId, entry.chat ?? chat)
    await this.acknowledge(chat)
    try {
      await this.prompt(entry.sessionId, chat, key, text)
    } catch (error) {
      if (!isMissingSession(error)) {
        await this.send(chat, `⚠️ 无法提交任务：${errorText(error)}`)
        return
      }
      // The DSH Session was archived or removed: bind a fresh one and retry once.
      this.log('bridge.session.stale', entry.sessionId)
      const sessionId = await this.createSession(key, chat)
      await this.prompt(sessionId, chat, key, text)
    }
  }

  async prompt(sessionId, chat, key, text) {
    this.turns.set(sessionId, { chat, key, startedAt: Date.now() })
    try {
      await this.ctx.sessionController.prompt(
        {
          requestId: crypto.randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
    } catch (error) {
      this.turns.delete(sessionId)
      throw error
    }
  }

  async acknowledge(chat) {
    if (!this.config.acknowledge) return
    this.send(chat, '⏳ 已收到，正在处理…').catch(() => {})
  }

  async createSession(key, chat) {
    // session.create accepts a workspaceId OR a cwd, never both.
    const workspaceId = this.config.workspaceId ?? (await this.ensureWorkspace())
    const request = workspaceId ? { workspaceId } : { cwd: this.config.cwd }
    if (this.config.agentPreset) request.agentPreset = this.config.agentPreset
    const value = await this.ctx.sessionController.create(request)
    const sessionId = value?.sessionId
    if (!sessionId) throw new Error('sessionController.create returned no sessionId')
    const entry = {
      key,
      sessionId,
      chat: {
        chatId: chat.chatId,
        chatType: chat.chatType,
        threadId: chat.threadId ?? null,
        rootId: chat.rootId ?? null,
      },
      cwd: this.config.cwd,
      createdAt: Date.now(),
    }
    this.store.set(key, entry)
    this.sessions.set(sessionId, entry.chat)
    this.log('bridge.session.created', `${key} -> ${sessionId}`)
    return sessionId
  }

  /** Give the Session a readable title in the DSH sidebar from its first Feishu task. */
  async titleSession(sessionId, text) {
    const title = text.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!title) return
    try {
      await this.ctx.sessionController.rename({ sessionId, title })
    } catch (error) {
      this.log('bridge.rename.failed', errorText(error), 'warn')
    }
  }

  // --------------------------------------------------------------- commands

  async onCommand(chat, name, rest) {
    const key = this.routeKey(chat)
    const entry = this.store.get(key)
    switch (name) {
      case 'help':
        await this.send(chat, HELP)
        return
      case 'new': {
        if (entry?.sessionId) this.turns.delete(entry.sessionId)
        const sessionId = await this.createSession(key, chat)
        await this.send(chat, `🆕 新会话已创建：${sessionId}`)
        return
      }
      case 'stop': {
        if (!entry?.sessionId) {
          await this.send(chat, '当前还没有绑定会话。')
          return
        }
        this.ctx.sessionController.cancel({ sessionId: entry.sessionId })
        this.turns.delete(entry.sessionId)
        await this.send(chat, '⏹ 已请求停止当前任务。')
        return
      }
      case 'approve':
        await this.decideApprovals(chat, 'allowed-once')
        return
      case 'reject':
        await this.decideApprovals(chat, 'rejected')
        return
      case 'status':
        await this.send(chat, await this.statusText(entry))
        return
      case 'doctor':
        await this.send(chat, this.doctorText())
        return
      case 'model':
        await this.onModelCommand(chat, entry, rest)
        return
      case 'models':
        await this.send(chat, await this.modelsText())
        return
      case 'title':
        await this.onTitleCommand(chat, entry, rest)
        return
      case 'cwd':
        await this.send(chat, `📁 工作目录：\`${this.config.cwd}\`\n（改目录：DSH → 插件 → 飞书远程桥接 → 配置）`)
        return
      case 'sessions':
        await this.send(chat, await this.sessionsText())
        return
      case 'resume': {
        if (!rest) {
          await this.send(chat, '用法：/resume <session-id>')
          return
        }
        await this.bindExisting(key, chat, rest)
        return
      }
      default:
        await this.send(chat, `未知指令 /${name}\n\n${HELP}`)
    }
  }

  async bindExisting(key, chat, sessionId) {
    let known = false
    try {
      const value = await this.ctx.sessionController.list({}, new AbortController().signal)
      known = Boolean(value?.items?.some((item) => item.sessionId === sessionId))
    } catch (error) {
      this.log('bridge.list.failed', errorText(error), 'warn')
    }
    if (!known) {
      await this.send(chat, `找不到可用的会话：${sessionId}`)
      return
    }
    this.store.set(key, {
      key,
      sessionId,
      chat: { chatId: chat.chatId, chatType: chat.chatType, threadId: chat.threadId ?? null, rootId: chat.rootId ?? null },
      cwd: this.config.cwd,
      createdAt: Date.now(),
    })
    this.sessions.set(sessionId, this.store.get(key).chat)
    await this.send(chat, `🔗 已绑定会话：${sessionId}`)
  }

  /** `/doctor`: one message that answers "which link is broken". */
  doctorText() {
    const d = this.diagnostics()
    const marks = { ready: '✅', disabled: '❌', starting: '⏳', restarting: '⏳', unknown: '❔' }
    const label = (key) => (key === 'im.message.receive_v1' ? '消息接收' : key === 'card.action.trigger' ? '卡片按钮' : key)
    const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '还没有收到过')
    const lines = [
      '🩺 桥接自检',
      '',
      `🔑 应用：${d.appId ?? '未知'}${d.workspace ? `（workspace：${d.workspace}）` : ''}`,
      `📁 工作目录：${d.cwd}`,
      `👥 白名单：${d.allowList} 人${d.allowList === 0 ? ' ← 空名单会拒绝所有人' : ''}`,
      `🔗 已绑定聊天：${d.bindings} 个`,
      '',
      '**事件通道**',
      ...d.channels.map((c) => `　${marks[c.state] ?? '❔'} ${label(c.key)}（${c.key} / ${c.state}）`),
      '',
      '**活动**',
      `· 累计入站：${d.inboundCount} 条`,
      `· 最近入站：${when(d.lastInboundAt)}${d.lastInboundFrom ? `（${d.lastInboundFrom.slice(0, 12)}…）` : ''}`,
      `· 待处理：授权 ${d.pendingApprovals} · 提问 ${d.pendingQuestion}`,
      `· 发送失败累计：${d.outboundFailures}`,
      `· 已运行：${formatElapsed(d.uptimeMs)}`,
      '',
      '**能力开关**',
      `· 卡片按钮：${d.cardButtons ? '开' : '关'}${d.cardButtons ? '' : '（回数字即可）'}`,
      `· 授权接管：${d.feishuApprovals ? '开' : '关'} · 提问接管：${d.feishuQuestions ? '开' : '关'}`,
    ]
    const message = d.channels.find((c) => c.key === 'im.message.receive_v1')
    if (message && message.state !== 'ready') {
      lines.push('', '⚠️ 消息通道未就绪：确认应用已发布、事件订阅方式是长连接、并订阅了 `im.message.receive_v1`。')
    }
    const card = d.channels.find((c) => c.key === 'card.action.trigger')
    if (card && card.state === 'disabled') {
      lines.push('', '⚠️ 卡片按钮不可用：到开放平台给该应用订阅回调 `card.action.trigger` 并发布版本，然后重载插件。')
    }
    if (d.inboundCount === 0) {
      lines.push('', '💡 一条消息都没收到过：先在飞书里给机器人发任意一句话，再看这里。')
    }
    return lines.join('\n')
  }

  /** `/model` reads the current selection; with an argument it switches. */
  async onModelCommand(chat, entry, rest) {
    if (!entry?.sessionId) {
      await this.send(chat, '当前还没有绑定会话，先发一句任务或 /new。')
      return
    }
    const raw = String(rest ?? '').trim()
    if (!raw) {
      const current = await this.currentModel(entry.sessionId)
      await this.send(chat, current)
      return
    }

    // Provider names may contain spaces ("DeepSeek Account"), so split at the
    // LAST slash and take the effort as the token after the model name.
    const slash = raw.lastIndexOf('/')
    let providerText = ''
    let tail
    if (slash > 0) {
      providerText = raw.slice(0, slash).trim()
      tail = raw.slice(slash + 1).trim().split(/\s+/).filter(Boolean)
    } else {
      tail = raw.split(/\s+/).filter(Boolean)
    }
    const modelText = tail[0]
    const effort = tail[1]
    if (!modelText) {
      await this.send(chat, '用法：/model <provider>/<model> [effort]，或 /model <model> [effort]\n例如：/model DeepSeek Account/DeepSeek-V4.1-Flash high')
      return
    }

    const resolved = await this.resolveModelRoute(providerText, modelText, entry.sessionId)
    if (resolved.error) {
      await this.send(chat, resolved.error)
      return
    }

    try {
      const result = await this.ctx.sessionController.selectModel({
        sessionId: entry.sessionId,
        provider: resolved.provider,
        model: resolved.model,
        ...(effort ? { reasoningEffort: effort } : {}),
      })
      const selected = result?.selected ?? { provider: resolved.provider, model: resolved.model }
      this.log(
        'bridge.model.selected',
        `${entry.sessionId} ${selected.provider}/${selected.model}${selected.reasoningEffort ? `@${selected.reasoningEffort}` : ''} (asked ${providerText || '-'}/${modelText})`,
      )
      await this.send(
        chat,
        `✅ 已切换模型：\`${selected.provider}/${selected.model}\`${selected.reasoningEffort ? `（effort: ${selected.reasoningEffort}）` : ''}\n下一轮生效。`,
      )
    } catch (error) {
      this.log('bridge.model.select.failed', errorText(error), 'warn')
      await this.send(chat, `⚠️ 切换失败：${errorText(error)}\n可用 /models 查看名字。`)
    }
  }

  /**
   * Map what the user typed onto real route ids. Display names carry spaces and
   * the ids differ (`DeepSeek Account` → `deepseek-account`), so match by id,
   * then by exact name, then by substring, and report candidates otherwise.
   */
  async resolveModelRoute(providerText, modelText, sessionId) {
    const llm = this.safeLlm()
    const norm = (value) => String(value ?? '').trim().toLowerCase()
    const compact = (value) => norm(value).replace(/\s+/g, '-')
    const idOf = (provider) => provider?.provider ?? provider?.id ?? provider?.name

    if (!llm || typeof llm.listProviders !== 'function') {
      // No directory: pass the input through and let selectModel validate it.
      if (!providerText) {
        const current = await this.currentSelection(sessionId)
        if (!current?.provider) return { error: '不知道当前 provider，请用 /model <provider>/<model>。' }
        return { provider: current.provider, model: modelText }
      }
      return { provider: providerText, model: modelText }
    }

    const providers = llm.listProviders() ?? []
    let provider
    if (providerText) {
      provider =
        providers.find((item) => norm(idOf(item)) === norm(providerText)) ??
        providers.find((item) => norm(item.name) === norm(providerText)) ??
        providers.find((item) => compact(item.name) === compact(providerText)) ??
        providers.find(
          (item) => norm(idOf(item)).includes(norm(providerText)) || norm(providerText).includes(norm(idOf(item))),
        ) ??
        providers.find((item) => norm(item.name ?? '').includes(norm(providerText)))
    } else {
      const current = await this.currentSelection(sessionId)
      provider = providers.find((item) => idOf(item) === current?.provider)
    }
    if (!provider) {
      const names = providers.map((item) => `${item.name ?? idOf(item)}（${idOf(item)}）`).slice(0, 10)
      return { error: `找不到 provider「${providerText || '当前'}」。\n可选：\n${names.map((n) => `· ${n}`).join('\n')}` }
    }

    const providerId = idOf(provider)
    let models = []
    try {
      models = (await llm.listModels(providerId)) ?? []
    } catch (error) {
      this.log('bridge.model.list.failed', `${providerId} ${errorText(error)}`, 'warn')
    }
    if (models.length === 0) return { provider: providerId, model: modelText }

    const model =
      models.find((item) => norm(item.id) === norm(modelText)) ??
      models.find((item) => norm(item.name) === norm(modelText)) ??
      models.find((item) => compact(item.id) === compact(modelText)) ??
      models.find((item) => compact(item.name) === compact(modelText)) ??
      models.find((item) => norm(item.id).includes(compact(modelText)) || compact(modelText).includes(norm(item.id))) ??
      models.find((item) => norm(item.name ?? '').includes(norm(modelText)))
    if (!model) {
      const list = models.map((item) => item.id).slice(0, 20)
      return { error: `「${provider.name ?? providerId}」里找不到模型「${modelText}」。\n可选：\n${list.map((id) => `· ${id}`).join('\n')}` }
    }
    return { provider: providerId, model: model.id }
  }

  safeLlm() {
    try {
      return this.ctx.get?.('llm')
    } catch {
      return undefined
    }
  }

  async currentSelection(sessionId) {
    try {
      const value = await this.ctx.sessionController.list({}, new AbortController().signal)
      const item = value?.items?.find((entry) => entry.sessionId === sessionId)
      const selection = item?.projections?.values?.modelSelection
      return selection?.next ?? selection?.lastUsed ?? undefined
    } catch {
      return undefined
    }
  }

  async currentModel(sessionId) {
    const next = await this.currentSelection(sessionId)
    if (!next) return '当前模型：由宿主默认决定（尚未记录选择）。用 /models 看可选模型。'
    return `当前模型：\`${next.provider}/${next.model}\`${next.reasoningEffort ? `（effort: ${next.reasoningEffort}）` : ''}\n切换：/model <provider>/<model> [effort]，也可以只给模型名。`
  }

  async modelsText() {
    // Cordis throws on property access to an undeclared service, so only the
    // safe accessor may be used here (this plugin does not inject `llm`).
    const llm = this.safeLlm()
    if (!llm || typeof llm.listProviders !== 'function') {
      return [
        '当前插件上下文里拿不到模型目录（`llm` 服务未注入）。',
        '',
        '可以用 /model 切换（需要知道 provider/model 名字），或在 DSH 网页端的模型选择里查看可用列表。',
      ].join('\n')
    }
    try {
      const providers = llm.listProviders() ?? []
      const lines = ['🧠 可用模型（/model <provider>/<model> 切换）']
      for (const provider of providers.slice(0, 8)) {
        const id = provider.provider ?? provider.id ?? provider.name
        if (!id) continue
        lines.push('', `**${provider.name ?? id}**（${id}）`)
        try {
          const models = (await llm.listModels(id)) ?? []
          for (const model of models.slice(0, 12)) {
            const label = model.name && model.name !== model.id ? `${model.id}（${model.name}）` : model.id
            lines.push(`· ${label}`)
          }
          if (models.length > 12) lines.push(`· …还有 ${models.length - 12} 个`)
        } catch (error) {
          lines.push(`· 读取失败：${errorText(error)}`)
        }
      }
      return lines.join('\n')
    } catch (error) {
      return `读取模型目录失败：${errorText(error)}`
    }
  }

  async onTitleCommand(chat, entry, rest) {
    if (!entry?.sessionId) {
      await this.send(chat, '当前还没有绑定会话。')
      return
    }
    const title = String(rest ?? '').trim()
    if (!title) {
      await this.send(chat, '用法：/title <新标题>')
      return
    }
    try {
      await this.ctx.sessionController.rename({ sessionId: entry.sessionId, title })
      await this.send(chat, `✅ 已改名：${title}`)
    } catch (error) {
      await this.send(chat, `⚠️ 改名失败：${errorText(error)}`)
    }
  }

  async statusText(entry) {
    if (!entry?.sessionId) {
      return '当前飞书会话还没有绑定 DSH 会话。直接发一条消息即可自动创建。'
    }
    const running = await this.isRunning(entry.sessionId)
    const health = this.lark.health()
    const marks = { ready: '✅', disabled: '❌', starting: '⏳', restarting: '⏳', unknown: '❔' }
    return [
      `📋 会话：${entry.sessionId}`,
      `📁 目录：${entry.cwd ?? this.config.cwd}`,
      `⚙️ 状态：${running ? '运行中' : '空闲'}`,
      `🔑 应用：${this.identity?.appId ?? '未知'}${this.identity?.workspace ? ` @ ${this.identity.workspace}` : ''}`,
      `📡 通道：${health.map((item) => `${item.key === 'card.action.trigger' ? '卡片' : '消息'}${marks[item.state] ?? '❔'}`).join(' ')}`,
      `🕐 更新：${new Date(entry.updatedAt ?? Date.now()).toLocaleString('zh-CN')}`,
    ].join('\n')
  }

  async sessionsText() {
    try {
      const value = await this.ctx.sessionController.list({}, new AbortController().signal)
      const items = (value?.items ?? [])
        .filter((item) => !item.parentSessionId)
        .slice(0, 8)
      if (items.length === 0) return '还没有任何会话。'
      const lines = items.map((item) => {
        const when = new Date(item.updatedAt ?? Date.now()).toLocaleString('zh-CN')
        return `${item.running ? '▶️' : '·'} ${item.sessionId}  ${when}`
      })
      return ['🗂 最近会话（/resume <id> 绑定）：', ...lines].join('\n')
    } catch (error) {
      return `读取会话列表失败：${errorText(error)}`
    }
  }

  async isRunning(sessionId) {
    try {
      const value = await this.ctx.sessionController.list({}, new AbortController().signal)
      return Boolean(value?.items?.find((item) => item.sessionId === sessionId)?.running)
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------- mirroring

  onSessionEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId || !event) return
    const turn = this.turns.get(sessionId)
    const chat = turn?.chat ?? this.sessions.get(sessionId)
    if (!chat) return
    if (event.type === 'assistant/message') {
      const text = textOfMessage(event.data?.message)
      if (text.trim()) this.send(chat, text).catch((error) => this.log('bridge.send.failed', errorText(error)))
      return
    }
    if (event.type === 'tool/call' && this.config.showTools) {
      this.send(chat, `🔧 ${event.data?.name ?? 'tool'}`).catch(() => {})
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data?.reason?.kind ?? 'unknown'
      const elapsed = turn ? formatElapsed(Date.now() - turn.startedAt) : ''
      this.turns.delete(sessionId)
      if (turn?.key) this.store.touch(turn.key)
      const suffix = elapsed ? ` · ${elapsed}` : ''
      const footer =
        reason === 'completed'
          ? `✅ 完成${suffix}`
          : reason === 'aborted' || reason === 'interrupted'
            ? `⏹ 已停止${suffix}`
            : `⚠️ 结束（${reason}）${suffix}`
      this.send(chat, footer).catch(() => {})
    }
  }

  // --------------------------------------------------------------- approvals

  /**
   * `approval/request` waterfall: claim the decision when its Session belongs to
   * a Feishu conversation, so a tool that needs authorization asks the phone
   * instead of stalling on an answerer nobody is watching.
   *
   * Returning an outcome claims the request; `next()` delegates to the composed
   * answerers (the Web UI), which is what every non-Feishu Session must do.
   */
  async onApprovalRequest(request, next) {
    const sessionId = request?.agent?.id
    if (!sessionId) return next()
    const mode = this.config.approvalChannel
    if (mode === 'host') return next()
    if (this.config.feishuApprovals === false) return next()
    const chat = this.turns.get(sessionId)?.chat ?? this.sessions.get(sessionId)
    if (!chat) return next()

    if (mode !== 'both') return this.askApproval(sessionId, chat, request)

    // 'both': keep the Web UI dialog alive as an alternative and let the first
    // answer win. The losing side cannot be dismissed remotely, so each side is
    // told which one settled it.
    const other = next()
    const mine = this.askApproval(sessionId, chat, request)
    const first = await Promise.race([
      mine.then((outcome) => ({ who: 'feishu', outcome })),
      other.then((outcome) => ({ who: 'host', outcome })),
    ])
    if (first.who === 'host') {
      this.dismissApprovals(sessionId, 'host answered elsewhere')
      this.send(chat, '这次授权已在网页端处理，飞书卡片可忽略。').catch(() => {})
    } else {
      this.send(chat, '已按飞书的选择处理；网页端的弹窗可以关掉。').catch(() => {})
    }
    return first.outcome
  }

  /** Settle every pending approval of one session without replying, quietly. */
  dismissApprovals(sessionId, why) {
    const list = this.pending.get(sessionId)
    if (!list) return 0
    let count = 0
    for (const entry of [...list]) {
      if (this.settleApproval(sessionId, entry.id, 'cancelled', why)) count += 1
    }
    return count
  }

  askApproval(sessionId, chat, request) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID().slice(0, 8)
      const timeoutMs = this.config.approvalTimeoutMs
      const entry = { id, toolName: request.toolName, callId: request.callId, resolve, timer: undefined }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => this.settleApproval(sessionId, id, 'rejected', 'timeout'), timeoutMs)
        entry.timer.unref?.()
      }
      const list = this.pending.get(sessionId) ?? []
      list.push(entry)
      this.pending.set(sessionId, list)
      this.rememberCard(id, chat, timeoutMs)

      if (request.signal) {
        const signal = request.signal
        if (signal.aborted) {
          this.settleApproval(sessionId, id, 'cancelled', 'aborted')
          return
        }
        signal.addEventListener('abort', () => this.settleApproval(sessionId, id, 'cancelled', 'aborted'), { once: true })
      }

      const reason = approvalReason(request)
      const minutes = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, Math.round(timeoutMs / 60000)) : 0
      const lines = [
        `🔐 需要授权：\`${request.toolName}\``,
        reason ? `原因：${reason}` : '',
        '',
        `/approve 允许一次 · /reject 拒绝${minutes ? ` · ${minutes} 分钟内有效` : ''}`,
      ].filter(Boolean)
      this.log('bridge.approval.requested', `${sessionId} ${id} ${request.toolName}`)
      this.send(chat, lines.join('\n'), this.approvalCard(request.toolName, reason, id)).catch((error) =>
        this.log('bridge.approval.notify.failed', errorText(error)),
      )
    })
  }

  settleApproval(sessionId, id, outcome, why) {
    const list = this.pending.get(sessionId)
    if (!list) return false
    const index = list.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    const [entry] = list.splice(index, 1)
    if (entry.timer) clearTimeout(entry.timer)
    if (list.length === 0) this.pending.delete(sessionId)
    try {
      entry.resolve(outcome)
    } catch (error) {
      this.log('bridge.approval.resolve.failed', errorText(error), 'warn')
    }
    this.log('bridge.approval.settled', `${sessionId} ${id} ${outcome}${why ? ` (${why})` : ''}`)
    return true
  }

  cancelAllApprovals(why) {
    for (const [sessionId, list] of this.pending) {
      if (list.length > 0) {
        const chat = this.turns.get(sessionId)?.chat ?? this.sessions.get(sessionId)
        if (chat) {
          // Tell the conversation now: the promise dies with the fiber, so a
          // later click could only discover the loss after the fact.
          this.send(chat, '⌛ 桥接正在重载，刚才那条授权请求已作废。需要的话请重新触发这个任务。').catch(() => {})
        }
      }
      for (const entry of [...list]) this.settleApproval(sessionId, entry.id, 'cancelled', why)
    }
    this.pending.clear()
  }

  /** `/approve` and `/reject` answer every pending request of this conversation. */
  async decideApprovals(chat, outcome) {
    const entry = this.store.get(this.routeKey(chat))
    const sessionId = entry?.sessionId
    const list = sessionId ? this.pending.get(sessionId) : undefined
    if (!list || list.length === 0) {
      await this.send(chat, '当前没有待授权的请求。')
      return
    }
    for (const item of [...list]) this.settleApproval(sessionId, item.id, outcome, 'user')
    await this.send(chat, outcome === 'allowed-once' ? '✅ 已批准（仅本次）。' : '🚫 已拒绝。')
  }

  // --------------------------------------------------------------- questions

  /**
   * `user-questions/request` waterfall: the agent asking 1/2/3 instead of
   * approving a tool. We ask the conversation and map the reply back to the
   * option labels the answer contract expects.
   */
  async onUserQuestionRequest(request, next) {
    const sessionId = request?.agent?.id
    if (!sessionId || this.config.feishuQuestions === false) return next()
    const chat = this.turns.get(sessionId)?.chat ?? this.sessions.get(sessionId)
    if (!chat) return next()

    const answers = []
    for (const item of request.questions ?? []) {
      const answer = await this.askOneQuestion(sessionId, chat, item, request.signal)
      if (!answer) return next()
      answers.push(answer)
    }
    if (answers.length === 0) return next()
    return { answers }
  }

  askOneQuestion(sessionId, chat, item, signal) {
    return new Promise((resolve) => {
      const options = Array.isArray(item.options) ? item.options : []
      const lines = [`❓ ${item.header ? `【${item.header}】` : ''}${item.question}`]
      if (item.detail) lines.push(item.detail)
      options.forEach((option, index) => {
        const hint = option.description ? ` — ${option.description}` : ''
        lines.push(`${index + 1}. ${option.label}${hint}`)
      })
      lines.push('')
      lines.push(
        options.length === 0
          ? '直接回复文字即可。'
          : item.multiSelect
            ? '回复序号选择（多选用 1,3），或直接回文字。'
            : '回复序号选择，或直接回文字。',
      )

      const id = crypto.randomUUID().slice(0, 8)
      const entry = { id, item, options, resolve, timer: undefined, multi: item.multiSelect === true }
      const timeoutMs = this.config.questionTimeoutMs
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        entry.timer = setTimeout(() => this.settleQuestion(sessionId, id, null, 'timeout'), timeoutMs)
        entry.timer.unref?.()
      }
      this.questions.set(sessionId, entry)
      this.rememberCard(entry.id, { chat }, timeoutMs)
      if (signal) {
        if (signal.aborted) {
          this.settleQuestion(sessionId, id, null, 'aborted')
          return
        }
        signal.addEventListener('abort', () => this.settleQuestion(sessionId, id, null, 'aborted'), { once: true })
      }
      this.log('bridge.question.requested', `${sessionId} ${id} ${item.question.slice(0, 60)}`)
      this.send(chat, lines.join('\n'), options.length > 0 ? this.questionCard(item, id) : undefined).catch((error) =>
        this.log('bridge.question.notify.failed', errorText(error)),
      )
    })
  }

  /** Remember which conversation a card went to, so a late click can be answered. */
  rememberCard(id, chat, timeoutMs) {
    if (!id) return
    this.cardChats.set(String(id), chat)
    const keepMs = Math.max(Number.isFinite(timeoutMs) ? timeoutMs * 2 : 600000, 600000)
    const timer = setTimeout(() => this.cardChats.delete(String(id)), keepMs)
    timer.unref?.()
  }

  /** Answer a click on a card that is already settled or expired. */
  async noteStaleCard(id, what, fallbackChatId) {
    const chat = (id ? this.cardChats.get(String(id)) : undefined) ?? (fallbackChatId ? { chatId: fallbackChatId } : undefined)
    if (!chat) return
    const text =
      what === 'approval'
        ? '⌛ 这张授权卡片已经失效（已处理或超时）。需要的话请重新发起任务。'
        : '⌛ 这张卡片已经失效（已作答或超时），本次选择没有生效。请重新发起任务让我再问一次。'
    await this.send(chat, text).catch(() => {})
  }

  settleQuestion(sessionId, id, answer, why) {
    const entry = this.questions.get(sessionId)
    if (!entry || entry.id !== id) return false
    this.questions.delete(sessionId)
    if (entry.timer) clearTimeout(entry.timer)
    try {
      entry.resolve(answer)
    } catch (error) {
      this.log('bridge.question.resolve.failed', errorText(error), 'warn')
    }
    this.log('bridge.question.settled', `${sessionId} ${id} ${answer ? answer.selected.join(',') || answer.custom || 'text' : why ?? 'none'}`)
    return true
  }

  /** Map one free-text reply onto the pending question, if any. */
  async answerPendingQuestion(sessionId, text) {
    const entry = this.questions.get(sessionId)
    if (!entry) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    const picked = []
    if (entry.options.length > 0) {
      for (const token of trimmed.split(/[\s,，、]+/).filter(Boolean)) {
        const index = Number(token.replace(/[.。)]$/, ''))
        if (Number.isInteger(index) && index >= 1 && index <= entry.options.length) {
          picked.push(entry.options[index - 1].label)
        }
      }
      if (picked.length === 0) {
        // A label typed verbatim also counts as a choice.
        const byLabel = entry.options.find((option) => option.label === trimmed)
        if (byLabel) picked.push(byLabel.label)
      }
    }
    if (picked.length > 0) {
      const selected = entry.multi ? [...new Set(picked)] : [picked[0]]
      this.settleQuestion(sessionId, entry.id, { id: entry.item.id, selected }, 'reply')
      return true
    }
    // Free text, or options the user answered in words.
    this.settleQuestion(sessionId, entry.id, { id: entry.item.id, selected: [], custom: trimmed }, 'reply')
    return true
  }

  // ---------------------------------------------------------------- cards

  /** Keep a card label short; the full text stays in the message and in the button value. */
  shortLabel(text, max = 20) {
    const value = String(text ?? '').trim().replace(/\s+/g, ' ')
    return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`
  }

  /**
   * One interactive card carrying the question's options as buttons plus a free
   * text input.
   *
   * Card space is scarce and the API caps payload size, so the card stays small
   * in a predictable way: the question is clipped, button labels are shortened,
   * and the FULL option text travels in the button `value` (which is what the
   * answer contract needs) while the complete wording lives in the companion
   * text message, which has no such limit.
   */
  questionCard(item, questionId) {
    const options = Array.isArray(item.options) ? item.options : []
    const elements = []
    const question = String(item.question ?? '')
    const shown = question.length > 600 ? `${question.slice(0, 599)}…（完整内容见上方消息）` : question
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: shown } })

    if (options.length > 0) {
      // Full option text lives in a wrapping block, never inside a button: a
      // button label is a single short line and truncates, a div wraps.
      let listed = options
        .slice(0, 8)
        .map((option, index) => {
          const hint = option.description ? `：${option.description}` : ''
          return `**${index + 1}.** ${option.label}${hint}`
        })
        .join('\n')
      if (listed.length > 1800) listed = `${listed.slice(0, 1799)}…（完整内容见上方消息）`
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: listed } })
      elements.push({
        tag: 'action',
        actions: options.slice(0, 8).map((option, index) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: String(index + 1) },
          type: index === 0 ? 'primary' : 'default',
          value: { kind: 'question', id: questionId, option: option.label },
        })),
      })
    }

    if (this.config.questionFreeText !== false) {
      // The question id is encoded in every form component name: inside a form
      // the button's `action_value` may be empty, but `action_name`/`form_value`
      // keys always come back, so the submit stays identifiable.
      elements.push({
        tag: 'form',
        name: `qfree_${questionId}`,
        elements: [
          {
            tag: 'input',
            name: `qfree_text_${questionId}`,
            input_type: 'multiline_text',
            rows: 2,
            max_length: 1000,
            placeholder: { tag: 'plain_text', content: options.length ? '也可以在这里输入你的答案，然后点右边提交' : '在这里输入答案' },
          },
          {
            tag: 'button',
            name: `qfree_submit_${questionId}`,
            form_action_type: 'submit',
            type: 'default',
            text: { tag: 'plain_text', content: '提交文字答案' },
            value: { kind: 'question', id: questionId, free: true },
          },
        ],
      })
    }

    const minutes = Number.isFinite(this.config.questionTimeoutMs) && this.config.questionTimeoutMs > 0
      ? Math.max(1, Math.round(this.config.questionTimeoutMs / 60000))
      : 0
    if (minutes > 0) {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `⏱ 本卡片 ${minutes} 分钟内有效；超时后请重新提问。` }] })
    }

    return {
      config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: this.shortLabel(item.header || 'DSH 需要你的选择', 30) } },
      elements,
    }
  }

  approvalCard(toolName, reason, approvalId) {
    return {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: '需要授权' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**${toolName}**${reason ? `\n${reason}` : ''}`.slice(0, 800) } },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '✅ 允许一次' }, type: 'primary', value: { kind: 'approval', id: approvalId, decision: 'approve' } },
            { tag: 'button', text: { tag: 'plain_text', content: '🚫 拒绝' }, type: 'danger', value: { kind: 'approval', id: approvalId, decision: 'reject' } },
          ],
        },
      ],
    }
  }

  /** `card.action.trigger`: a button click answering an approval or a question. */
  async onCardAction(payload) {
    const actionName = String(payload?.action_name ?? '')
    let value = readCardValue(payload)
    if (!value || typeof value !== 'object') {
      if (actionName.startsWith('qfree_submit')) {
        const id = actionName.slice('qfree_submit'.length).replace(/^_+/, '')
        value = { kind: 'question', free: true, id: id || undefined }
      } else if (readFormValue(payload)) {
        // A submit whose component name we did not author; the single pending
        // question still identifies it.
        value = { kind: 'question', free: true }
      } else {
        this.log('card.action.unparsed', JSON.stringify(payload).slice(0, 600), 'warn')
        return
      }
    }
    const operator = payload?.operator?.open_id ?? payload?.open_id ?? payload?.sender_id
    if (operator && this.config.allowOpenIds.length > 0 && !this.config.allowOpenIds.includes(operator)) {
      this.log('card.action.rejected-operator', String(operator))
      return
    }
    const chat = this.chatForPending(value)
    if (value.kind === 'approval' && value.id) {
      const sessionId = findKeyByApproval(this.pending, value.id)
      if (!sessionId) {
        this.log('card.action.stale-approval', String(value.id))
        await this.noteStaleCard(value.id, 'approval', payload?.chat_id)
        return
      }
      const outcome = value.decision === 'approve' ? 'allowed-once' : 'rejected'
      this.settleApproval(sessionId, value.id, outcome, 'card')
      if (chat) await this.send(chat, outcome === 'allowed-once' ? '✅ 已批准（仅本次）。' : '🚫 已拒绝。').catch(() => {})
      return
    }
    if (value.kind === 'question' && (value.id || value.free === true)) {
      let found = value.id ? [...this.questions.entries()].find(([, item]) => item.id === value.id) : undefined
      if (!found && this.questions.size === 1) found = [...this.questions.entries()][0]
      if (!found) {
        this.log('card.action.stale-question', String(value.id))
        await this.noteStaleCard(value.id, 'question', payload?.chat_id)
        return
      }
      const [sessionId, entry] = found
      if (value.free === true) {
        // Form submit: the typed text is the answer unless the user also picked.
        const typed = readFormValue(payload, entry.id)
        if (!typed) {
          this.log('card.action.empty-free-text', String(value.id), 'warn')
          this.log('card.action.payload', JSON.stringify(payload).slice(0, 1200), 'warn')
          return
        }
        this.settleQuestion(sessionId, value.id, { id: entry.item.id, selected: [], custom: typed }, 'card-form')
        return
      }
      const label = String(value.option ?? '')
      const selected = entry.options.some((option) => option.label === label) ? [label] : []
      this.settleQuestion(
        sessionId,
        value.id,
        { id: entry.item.id, selected, custom: selected.length ? undefined : label },
        'card',
      )
      return
    }
    this.log('card.action.unknown', JSON.stringify(value).slice(0, 200), 'warn')
  }

  chatForPending(value) {
    for (const [sessionId, list] of this.pending) {
      if (list.some((entry) => entry.id === value.id)) {
        return this.turns.get(sessionId)?.chat ?? this.sessions.get(sessionId)
      }
    }
    for (const [sessionId, entry] of this.questions) {
      if (entry.id === value.id) return this.turns.get(sessionId)?.chat ?? this.sessions.get(sessionId)
    }
    return undefined
  }

  // ---------------------------------------------------------------- outbound

  async send(chat, text, card) {
    if (card) {
      const sent = await this.sendOne(chat, undefined, card).catch((error) => {
        this.log('lark.card.failed', errorText(error), 'warn')
        return undefined
      })
      if (sent) return
      // Fall back to plain text when the card is refused.
    }
    const chunks = chunkText(text, this.config.chunkLimit)
    for (const chunk of chunks) {
      await this.sendOne(chat, chunk)
    }
  }

  async sendOne(chat, text, card) {
    const inThread = Boolean(this.config.replyInThread && chat.chatId && (chat.rootId || chat.threadId))
    const contentArgs = card
      ? ['--msg-type', 'interactive', '--content', JSON.stringify(card)]
      : ['--markdown', text]
    const target = chat.chatId ? ['--chat-id', chat.chatId] : ['--user-id', chat.openId]
    const args = inThread
      ? [
          'im',
          '+messages-reply',
          '--as',
          this.config.identity,
          '--message-id',
          chat.rootId ?? chat.messageId,
          '--reply-in-thread',
          ...contentArgs,
          '--format',
          'json',
        ]
      : ['im', '+messages-send', '--as', this.config.identity, ...target, ...contentArgs, '--format', 'json']
    try {
      const result = await this.lark.call(args)
      if (result && result.ok === false) {
        this.log('lark.send.rejected', JSON.stringify(result).slice(0, 400), 'warn')
      }
      return result
    } catch (error) {
      this.outboundFailures += 1
      this.log('lark.send.failed', errorText(error), 'error')
      throw error
    }
  }
}

/**
 * Attachments arrive as markers inside rendered `content`. Three shapes are in
 * play depending on who rendered them:
 *   [Image: img_v3_xxx]            ← lark-cli event normaliser (observed)
 *   ![Image](img_v3_xxx)           ← message-list / enrichment rendering
 *   <file key="file_v3_xxx" … />   ← raw post-style rendering
 * Plus a bare-key fallback for media types whose content is only the key.
 */
const NORMALISED_MARKER = /\[(Image|File|Audio|Video|Media|Sticker):\s*((?:img|file)_[A-Za-z0-9_-]+)\]/gi
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(((?:img)_[A-Za-z0-9_-]+)\)/g
const TAG_RESOURCE = /<(file|audio|video)\s+[^>]*?key="((?:file)_[A-Za-z0-9_-]+)"/g
const BARE_KEY = /(?:img|file)_[A-Za-z0-9_-]{16,}/g

function collectResources(content, messageType) {
  const text = String(content ?? '')
  const images = []
  const files = []
  let stickers = 0
  let cleaned = text

  for (const match of text.matchAll(NORMALISED_MARKER)) {
    const kind = match[1].toLowerCase()
    const key = match[2]
    if (kind === 'sticker') {
      stickers += 1
      continue
    }
    if (kind === 'image') images.push(key)
    else files.push({ kind, key })
  }
  for (const match of text.matchAll(MARKDOWN_IMAGE)) images.push(match[1])
  for (const match of text.matchAll(TAG_RESOURCE)) files.push({ kind: match[1], key: match[2] })
  cleaned = cleaned
    .replace(NORMALISED_MARKER, '')
    .replace(MARKDOWN_IMAGE, '')
    .replace(TAG_RESOURCE, '')

  if (images.length === 0 && files.length === 0) {
    const bare = cleaned.match(BARE_KEY)
    if (bare) {
      for (const key of bare) {
        if (key.startsWith('img')) images.push(key)
        else if (messageType === 'file' || messageType === 'audio' || messageType === 'media') {
          files.push({ kind: messageType === 'media' ? 'video' : messageType, key })
        }
      }
      cleaned = cleaned.replace(BARE_KEY, '')
    }
  }

  return {
    images: [...new Set(images)],
    files,
    stickers,
    cleaned: cleaned.replace(/[ \t]{2,}/g, ' ').trim(),
  }
}

/** Media type from a downloaded file's extension; images otherwise assumed PNG. */
function mediaTypeOf(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.png') return 'image/png'
  return 'image/png'
}

function isMissingSession(error) {
  const message = errorText(error)
  return /not-found|not found|session\/not-found/i.test(message)
}

/** Prefer the human wording a producer supplied, then its raw reason. */
function approvalReason(request) {
  const display = request?.displayReason
  if (display && typeof display === 'object') {
    const localized = display.zh ?? display['zh-CN'] ?? display['zh-cn'] ?? display.en
    if (typeof localized === 'string' && localized.trim()) return localized.trim()
  }
  if (typeof request?.reason === 'string' && request.reason.trim()) return request.reason.trim()
  return ''
}

/**
 * A card callback carries the button's `value` either as an object or as a JSON
 * string, under a few different keys depending on the producer. Accept all of
 * them rather than guessing one shape.
 */
function readCardValue(payload) {
  const candidates = [
    payload?.action?.value,
    payload?.action?.value?.value,
    payload?.action_value,
    payload?.card?.action?.value,
    payload?.value,
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (typeof candidate === 'object') return candidate
    if (typeof candidate === 'string') {
      try {
        return JSON.parse(candidate)
      } catch {
        continue
      }
    }
  }
  return undefined
}

/** Which session owns this approval id. */
function findKeyByApproval(pending, id) {
  for (const [sessionId, list] of pending) {
    if (list.some((entry) => entry.id === id)) return sessionId
  }
  return undefined
}

/**
 * A form submit reports its values in `form_value`: a JSON STRING keyed by
 * component name. Names carry the question id (`qfree_text_<id>`), so prefer the
 * exact one; fall back to any input-shaped key.
 */
function readFormValue(payload, questionId) {
  const container = parseMaybeJson(payload?.form_value) ?? parseMaybeJson(payload?.action?.form_value)
  const source = container && typeof container === 'object' ? container : payload
  if (questionId) {
    const exact = pickNamed(source, `qfree_text_${questionId}`)
    if (exact) return exact
  }
  const loose = pickNamed(source, 'qfree_text', 3)
  if (loose) return loose
  return pickPrefixed(source, 'qfree_text')
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function pickPrefixed(value, prefix, depth = 3, seen = new Set()) {
  if (depth < 0 || !value || typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith(prefix) && typeof child === 'string' && child.trim()) return child.trim()
    if (key === 'card_content' || key === 'content' || key === 'card') continue
    const found = pickPrefixed(child, prefix, depth - 1, seen)
    if (found) return found
  }
  return undefined
}

function pickNamed(value, name, depth = 4, seen = new Set()) {
  if (depth < 0 || value === null || value === undefined) return undefined
  if (typeof value === 'string') {
    const parsed = parseMaybeJson(value)
    return parsed === undefined ? undefined : pickNamed(parsed, name, depth - 1, seen)
  }
  if (typeof value !== 'object' || seen.has(value)) return undefined
  seen.add(value)
  if (typeof value[name] === 'string' && value[name].trim()) return value[name].trim()
  for (const [key, child] of Object.entries(value)) {
    // Never mine the rendered card, which echoes the question text back.
    if (key === 'card_content' || key === 'content' || key === 'card') continue
    const found = pickNamed(child, name, depth - 1, seen)
    if (found) return found
  }
  return undefined
}
