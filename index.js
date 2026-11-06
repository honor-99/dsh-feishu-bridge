/**
 * Feishu/Lark bridge bundle for DeepSeek Harness (Host half).
 *
 * Mounts one supervised `lark-cli event consume` long-connection consumer per
 * Host, binds each Feishu conversation to one DSH Session, and mirrors durable
 * Session output back into Feishu. All state lives in ordinary DSH Session logs
 * plus a small chat->session map, so the Web UI and Feishu show the same record.
 *
 * The bundle also owns its configuration channel: `<stateDir>/config.json`
 * overlays the Loader row's config, and two routes on the Harness web server
 * expose it to the bundle's own browser half. The profile patch stays the
 * composition source; this file is the runtime overlay.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { FeishuBridge } from './bridge.js'
import { LarkClient } from './lark.js'
import { ChatStore } from './store.js'
import { createLogger } from './util.js'

export const name = 'dsh-feishu-bridge'
export const inject = ['sessionController']
const BUILD = 'b5'

const ROUTE = '/feishu-bridge'
const OVERLAY_KEYS = [
  'cwd',
  'allowOpenIds',
  'identity',
  'nodePath',
  'cliScript',
  'cliCommand',
  'groupSessions',
  'groupRequiresMention',
  'replyInThread',
  'acknowledge',
  'showTools',
  'chunkLimit',
  'agentPreset',
  'feishuApprovals',
  'approvalChannel',
  'approvalTimeoutMs',
  'feishuQuestions',
  'questionTimeoutMs',
  'cardButtons',
  'questionFreeText',
  'attachments',
  'welcome',
  'unpairedReply',
]

/** Loader-row schema: the descriptions the Plugins page and Settings show. */
export const Config = Schema.object({
  cwd: Schema.string().description('会话工作目录，例如 D:\\dsh').default(''),
  allowOpenIds: Schema.array(Schema.string())
    .description('允许遥控的飞书 open_id 白名单，留空表示不限制')
    .default([]),
  identity: Schema.string().description('出站身份：bot 或 user').default('bot'),
  nodePath: Schema.string().description('本机 node 可执行文件绝对路径（留空自动探测）').default(''),
  cliScript: Schema.string().description('@larksuite/cli 的 scripts/run.js 绝对路径（留空自动探测）').default(''),
  cliCommand: Schema.string().description('未探测到 CLI 时使用的命令').default('lark-cli'),
  groupSessions: Schema.string().description('群聊会话粒度：thread 或 chat').default('thread'),
  groupRequiresMention: Schema.boolean().description('群聊是否必须 @ 机器人才响应').default(true),
  replyInThread: Schema.boolean().description('话题内回复是否使用 --reply-in-thread').default(true),
  acknowledge: Schema.boolean().description('收到任务先回一句「已收到」').default(true),
  showTools: Schema.boolean().description('是否把每次工具调用作为一条消息推到飞书').default(false),
  chunkLimit: Schema.number().description('单条飞书消息最大字符数').default(3200),
  feishuApprovals: Schema.boolean().description('把工具授权请求推到飞书并用 /approve 作答').default(true),
  approvalChannel: Schema.string()
    .description('授权在哪一端应答：feishu（只飞书）/ host（只网页）/ both（两端都弹，先答者生效）')
    .default('feishu'),
  approvalTimeoutMs: Schema.number().description('授权等待毫秒数，超时按拒绝处理').default(600000),
  feishuQuestions: Schema.boolean().description('接管 ask_user 的选项式提问').default(true),
  questionTimeoutMs: Schema.number().description('提问等待毫秒数（卡片在聊天里可能放很久，默认 30 分钟）').default(1800000),
  cardButtons: Schema.boolean().description('用交互卡片按钮代替打字选择').default(true),
  questionFreeText: Schema.boolean().description('卡片里附带“输入文字答案”的输入框').default(true),
  attachments: Schema.boolean().description('接收飞书发来的图片与文件').default(true),
  welcome: Schema.boolean().description('首次绑定后发一条使用引导（换应用会重发）').default(true),
  unpairedReply: Schema.boolean().description('未授权者在单聊里收到配对提示').default(true),
  agentPreset: Schema.string().description('指定 Agent 预设，留空用宿主默认').default(''),
  stateDir: Schema.string().description('状态与日志目录，留空用 ~/.dsh/feishu-bridge').default(''),
  probeOnStart: Schema.boolean().description('启动自检（调试用，会真建一个会话）').default(false),
})

export function apply(ctx, config) {
  const base = resolveConfig(config)
  const log = createLogger(base.logFile)
  const store = new ChatStore(base.stateFile)
  const overlayFile = path.join(base.stateDir, 'config.json')

  let active = null
  let overlay = readOverlay(overlayFile, log)

  const effective = () => resolveConfig({ ...(config ?? {}), ...overlay })
  const offSessionEvent = ctx.on('session/event', (session, event) => {
    active?.onSessionEvent(session, event)
  })
  // Claim tool approvals and structured questions for Feishu-bound Sessions;
  // everything else delegates to the composed answerers.
  //
  // `prepend` matters: the waterfall stops at the first listener that returns an
  // outcome, and the Web UI's answerer would otherwise claim the request before
  // this one runs, leaving the Feishu side with no prompt at all.
  const offApproval = ctx.on(
    'approval/request',
    (request, next) => {
      const bridge = active
      if (!bridge) return next()
      return bridge.onApprovalRequest(request, next)
    },
    { prepend: true },
  )
  const offQuestions = ctx.on(
    'user-questions/request',
    (request, next) => {
      const bridge = active
      if (!bridge) return next()
      return bridge.onUserQuestionRequest(request, next)
    },
    { prepend: true },
  )

  const mount = async () => {
    const resolved = effective()
    const lark = new LarkClient(resolved, log)
    active = new FeishuBridge({ ctx, config: resolved, store, lark, log })
    await active.start()
    active.onboard().catch((error) => log('welcome.failed', String(error), 'warn'))  }

  const remount = async (reason) => {
    const previous = active
    active = null
    try {
      await previous?.stop()
    } catch (error) {
      log('bridge.stop.failed', String(error), 'warn')
    }
    await mount()
    log('bridge.remounted', reason)
  }

  const routes = []
  const webServer = safeService(ctx, 'webServer')
  if (webServer && typeof webServer.register === 'function') {
    try {
      routes.push(
        webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler: (req, res) =>
            handleRoute(req, res, {
              base,
              effective,
              getOverlay: () => overlay,
              setOverlay: (next) => {
                overlay = next
              },
              overlayFile,
              log,
              remount,
              getActive: () => active,
            }),
        }),
      )
    } catch (error) {
      // A stale registration from the previous instance must not fail activation.
      log('config.route.duplicate', String(error), 'warn')
    }
  } else {
    log('config.routes.unavailable', 'no webServer service', 'warn')
  }

  // One-shot reachability check for the config route (status only; the body
  // carries open_ids and does not belong in a log). It proves the route is
  // mounted before the page is opened.
  if (webServer && typeof webServer.getOrigin === 'function') {
    const origin = webServer.getOrigin()
    if (origin) {
      fetch(`${origin}${ROUTE}/config`)
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          log('config.selfcheck', `status=${response.status} fields=${body?.config ? Object.keys(body.config).length : 0}`)
        })
        .catch((error) => log('config.selfcheck.failed', String(error), 'warn'))

      fetch(`${origin}${ROUTE}/status`)
        .then(async (response) => {
          const body = await response.json().catch(() => null)
          const diagnostics = body?.diagnostics
          log(
            'status.selfcheck',
            `status=${response.status} app=${diagnostics?.appId ?? 'none'} channels=${(diagnostics?.channels ?? []).map((c) => `${c.key}:${c.state}`).join(',')}`,
          )
        })
        .catch((error) => log('status.selfcheck.failed', String(error), 'warn'))
    }
  }

  ctx.effect(() => {
    mount().catch((error) => log('bridge.start.failed', String(error), 'error'))
    // `lark-cli profile use …` switches the bound application globally. The long
    // connection would stay on the old app while new sends use the new one, so
    // watch for drift and remount instead of splitting send and receive.
    const driftTimer = setInterval(async () => {
      const bridge = active
      const known = bridge?.identity?.appId
      if (!bridge || !known) return
      try {
        const current = await bridge.lark.describeIdentity()
        if (!current?.appId || current.appId === known) return
        log('bridge.app_switched', `${known} -> ${current.appId} (workspace ${current.workspace ?? '?'})`)
        await remount('application switched')
      } catch (error) {
        log('bridge.app_switch.check.failed', String(error), 'warn')
      }
    }, 120000)
    driftTimer.unref?.()
    return async () => {
      clearInterval(driftTimer)
      offSessionEvent?.()
      offApproval?.()
      offQuestions?.()
      for (const dispose of routes) {
        try {
          dispose()
        } catch {}
      }
      await active?.stop()
    }
  }, 'dsh-feishu-bridge.serve')

  log('plugin.mounted', JSON.stringify({ build: BUILD, cwd: effective().cwd, routes: routes.length, overlay }))

  if (base.probeOnStart) {    ;(async () => {
      try {
        const bridge = active
        const workspaceId = await bridge?.ensureWorkspace()
        const created = await ctx.sessionController.create(workspaceId ? { workspaceId } : { cwd: base.cwd })
        log('probe.created', JSON.stringify(created))
      } catch (error) {
        log('probe.failed', String(error), 'error')
      }
    })()
  }
}

function safeService(ctx, key) {
  try {
    return ctx.get?.(key)
  } catch {
    return undefined
  }
}

function readOverlay(file, log) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const overlay = {}
      for (const key of OVERLAY_KEYS) if (parsed[key] !== undefined) overlay[key] = parsed[key]
      return overlay
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') log('config.overlay.unreadable', String(error), 'warn')
  }
  return {}
}

function writeOverlay(file, overlay) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

/** Coerce one submitted field; undefined drops the key back to the row config. */
function coerce(key, value) {
  switch (key) {
    case 'allowOpenIds':
      if (!Array.isArray(value)) return undefined
      return value.map((item) => String(item).trim()).filter(Boolean)
    case 'chunkLimit': {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
    }
    case 'approvalTimeoutMs': {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
    }
    case 'feishuApprovals':
      return value === true
    case 'approvalChannel': {
      const text = String(value ?? '').trim().toLowerCase()
      return ['feishu', 'host', 'both'].includes(text) ? text : undefined
    }
    case 'feishuQuestions':
      return value === true
    case 'cardButtons':
      return value === true
    case 'questionFreeText':
      return value === true
    case 'attachments':
      return value === true
    case 'welcome':
      return value === true
    case 'unpairedReply':
      return value === true
    case 'questionTimeoutMs': {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined
    }
    case 'groupRequiresMention':
    case 'replyInThread':
    case 'acknowledge':
    case 'showTools':
      return value === true
    default: {
      const text = String(value ?? '').trim()
      return text === '' ? undefined : text
    }
  }
}

async function handleRoute(req, res, context) {
  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  const tail = url.pathname.slice(ROUTE.length)
  const json = (status, body) => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  }

  try {
    if (tail === '/status' && req.method === 'GET') {
      const bridge = context.getActive?.()
      json(200, {
        diagnostics: bridge ? bridge.diagnostics() : null,
        overlayFile: context.overlayFile,
        mountedAt: bridge ? bridge.startedAt : null,
      })
      return
    }

    if (tail === '/config' && req.method === 'GET') {
      const resolved = context.effective()
      json(200, {
        config: {
          cwd: resolved.cwd,
          allowOpenIds: resolved.allowOpenIds,
          identity: resolved.identity,
          nodePath: resolved.nodePath,
          cliScript: resolved.cliScript,
          cliCommand: resolved.cliCommand,
          groupSessions: resolved.groupSessions,
          groupRequiresMention: resolved.groupRequiresMention,
          replyInThread: resolved.replyInThread,
          acknowledge: resolved.acknowledge,
          showTools: resolved.showTools,
          chunkLimit: resolved.chunkLimit,
          feishuApprovals: resolved.feishuApprovals,
          approvalChannel: resolved.approvalChannel,
          approvalTimeoutMs: resolved.approvalTimeoutMs,
          feishuQuestions: resolved.feishuQuestions,
          questionTimeoutMs: resolved.questionTimeoutMs,
          cardButtons: resolved.cardButtons,
          questionFreeText: resolved.questionFreeText,
          attachments: resolved.attachments,
          welcome: resolved.welcome,
          unpairedReply: resolved.unpairedReply,
          agentPreset: resolved.agentPreset ?? '',
        },
        overlay: context.getOverlay(),
        overlayFile: context.overlayFile,
      })
      return
    }

    if (tail === '/config' && req.method === 'POST') {
      // Same-origin guard. This route is not behind the host's /api admission:
      // without these checks any web page could form-POST a JSON body with
      // text/plain (no preflight) and rewrite the allowlist.
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!contentType.startsWith('application/json')) {
        json(415, { error: 'unsupported-media-type', message: 'content-type must be application/json' })
        return
      }
      const site = String(req.headers['sec-fetch-site'] ?? '')
      if (site && site !== 'same-origin' && site !== 'none') {
        json(403, { error: 'forbidden', message: 'cross-site request refused' })
        return
      }
      const origin = req.headers.origin
      if (origin) {
        let originHost
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = undefined
        }
        if (!originHost || originHost !== req.headers.host) {
          json(403, { error: 'forbidden', message: 'origin mismatch' })
          return
        }
      }

      const body = await readJson(req)
      const next = { ...context.getOverlay() }
      for (const key of OVERLAY_KEYS) {
        if (!(key in body)) continue
        const value = coerce(key, body[key])
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      writeOverlay(context.overlayFile, next)
      context.setOverlay(next)
      await context.remount('config write')
      json(200, { saved: true, overlay: next })
      return
    }

    json(404, { error: 'not-found', path: url.pathname })
  } catch (error) {
    context.log('config.route.failed', String(error), 'error')
    json(500, { error: 'internal', message: String(error?.message ?? error) })
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('error', reject)
    req.on('end', () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {})
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error?.message ?? error}`))
      }
    })
  })
}

function resolveConfig(raw) {
  const config = raw ?? {}
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const stateDir = config.stateDir || path.join(home, 'feishu-bridge')
  return {
    nodePath: config.nodePath || '',
    cliScript: config.cliScript || '',
    cliCommand: config.cliCommand || 'lark-cli',
    identity: config.identity === 'user' ? 'user' : 'bot',
    cwd: config.cwd || process.cwd(),
    workspaceTitle: config.workspaceTitle || 'Feishu',
    workspaceId: config.workspaceId || undefined,
    agentPreset: config.agentPreset || undefined,
    allowOpenIds: Array.isArray(config.allowOpenIds) ? config.allowOpenIds.filter(Boolean) : [],
    groupSessions: config.groupSessions === 'chat' ? 'chat' : 'thread',
    groupRequiresMention: config.groupRequiresMention !== false,
    replyInThread: config.replyInThread !== false,
    acknowledge: config.acknowledge !== false,
    showTools: config.showTools === true,
    chunkLimit: Number.isFinite(config.chunkLimit) ? config.chunkLimit : 3200,
    feishuApprovals: config.feishuApprovals !== false,
    approvalChannel: ['feishu', 'host', 'both'].includes(config.approvalChannel) ? config.approvalChannel : 'feishu',
    approvalTimeoutMs: Number.isFinite(config.approvalTimeoutMs) ? config.approvalTimeoutMs : 600000,
    feishuQuestions: config.feishuQuestions !== false,
    questionTimeoutMs: Number.isFinite(config.questionTimeoutMs) ? config.questionTimeoutMs : 1800000,
    cardButtons: config.cardButtons !== false,
    questionFreeText: config.questionFreeText !== false,
    attachments: config.attachments !== false,
    welcome: config.welcome !== false,
    unpairedReply: config.unpairedReply !== false,
    probeOnStart: config.probeOnStart === true,
    stateDir,
    stateFile: config.stateFile || path.join(stateDir, 'state.json'),
    logFile: config.logFile || path.join(stateDir, 'bridge.log'),
  }
}
