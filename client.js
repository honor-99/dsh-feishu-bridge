/**
 * Browser half: the row configuration page for `feishu-bridge`.
 *
 * The Plugins page dispatches `plugins.row.config` keyed by
 * `<package name>#<row id>`. A bundle-declared row never matches the Host's
 * settings namespace (the Loader nests it as `include:<row>`), so this page does
 * not use the owner's `form`; it talks to the bundle's own Host routes under
 * `/feishu-bridge/config`, which persist an overlay and remount the bridge.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-feishu-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const ROW_KEY = '@local/dsh-feishu-bridge#feishu-bridge'
    const ENDPOINT = '/feishu-bridge/config'
    const STATUS_ENDPOINT = '/feishu-bridge/status'

    const FIELDS = [
      { key: 'cwd', label: '工作目录', kind: 'text', hint: 'Agent 在这个目录里干活；会话也归属到该路径的工作区' },
      { key: 'allowOpenIds', label: '允许的飞书 open_id', kind: 'list', hint: '一行一个。留空 = 拒绝所有人（被拒的 open_id 写进 bridge.log 的 rejected-unpaired）' },
      { key: 'groupSessions', label: '群聊会话粒度', kind: 'select', options: [['thread', '每个话题一个会话'], ['chat', '整群共用一个会话']] },
      { key: 'groupRequiresMention', label: '群里必须 @ 机器人才响应', kind: 'bool' },
      { key: 'acknowledge', label: '收到任务先回一句「已收到」', kind: 'bool' },
      { key: 'showTools', label: '把每次工具调用也推到飞书', kind: 'bool' },
      { key: 'chunkLimit', label: '单条消息字符上限', kind: 'number' },
      { key: 'feishuApprovals', label: '把工具授权请求推到飞书（/approve 作答）', kind: 'bool' },
      {
        key: 'approvalChannel',
        label: '授权应答位置',
        kind: 'select',
        options: [
          ['feishu', '只飞书（推荐）'],
          ['host', '只网页端'],
          ['both', '两端都弹，先答者生效'],
        ],
      },
      { key: 'approvalTimeoutMs', label: '授权等待毫秒数（超时按拒绝处理）', kind: 'number' },
      { key: 'feishuQuestions', label: '接管 ask_user 的选项式提问', kind: 'bool' },
      { key: 'questionTimeoutMs', label: '提问等待毫秒数', kind: 'number' },
      { key: 'cardButtons', label: '用卡片按钮代替打字选择', kind: 'bool' },
      { key: 'questionFreeText', label: '卡片里附带“输入文字答案”输入框', kind: 'bool' },
      { key: 'attachments', label: '接收飞书发来的图片与文件', kind: 'bool' },
      { key: 'welcome', label: '首次绑定后发送使用引导（换应用会重发）', kind: 'bool' },
      { key: 'unpairedReply', label: '未授权者在单聊收到配对提示', kind: 'bool' },
      { key: 'agentPreset', label: 'Agent 预设（留空用宿主默认）', kind: 'text' },
      { key: 'nodePath', label: 'node 绝对路径（可选覆盖）', kind: 'text', hint: '留空自动探测' },
      { key: 'cliScript', label: 'lark-cli 的 run.js 路径（可选覆盖）', kind: 'text', hint: '留空自动探测 PATH 上的 lark-cli' },
    ]

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, fontSize: 13, lineHeight: 1.5 },
      row: { display: 'flex', flexDirection: 'column', gap: 4 },
      label: { fontWeight: 600 },
      hint: { opacity: 0.65, fontSize: 12 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.45)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      check: { display: 'flex', alignItems: 'center', gap: 8 },
      actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 },
      button: {
        padding: '6px 14px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,0.45)',
        background: 'rgba(128,128,128,0.12)',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      },
      code: {
        display: 'block',
        padding: '6px 8px',
        borderRadius: 6,
        background: 'rgba(128,128,128,0.12)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      note: { padding: '8px 10px', borderRadius: 6, background: 'rgba(128,128,128,0.12)' },
    }

    const fromList = (text) =>
      String(text)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    function draftOf(values) {
      const draft = {}
      for (const field of FIELDS) {
        const value = values?.[field.key]
        if (field.kind === 'list') draft[field.key] = Array.isArray(value) ? value.join('\n') : ''
        else if (field.kind === 'bool') draft[field.key] = value === true
        else draft[field.key] = value === undefined || value === null ? '' : String(value)
      }
      return draft
    }

    function normalized(field, raw) {
      if (field.kind === 'list') return fromList(raw)
      if (field.kind === 'number') {
        const parsed = Number(raw)
        return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : ''
      }
      if (field.kind === 'bool') return Boolean(raw)
      return String(raw ?? '').trim()
    }

    function changed(field, draft, current) {
      if (field.kind === 'list') {
        const now = Array.isArray(current) ? current : []
        return fromList(draft).join('\n') !== now.join('\n')
      }
      if (field.kind === 'bool') return Boolean(current) !== Boolean(draft)
      const next = normalized(field, draft)
      if (next === '') return current !== undefined && current !== '' && current !== null
      return String(current ?? '') !== String(next)
    }

    function FieldRow({ field, value, onChange }) {
      const common = {
        style: S.input,
        value,
        onChange: (event) => onChange(event.target.value),
      }
      const control =
        field.kind === 'list'
          ? h('textarea', { ...common, style: { ...S.input, minHeight: 64, resize: 'vertical' }, spellCheck: false })
          : field.kind === 'bool'
            ? h('input', { type: 'checkbox', checked: Boolean(value), onChange: (event) => onChange(event.target.checked) })
            : field.kind === 'select'
              ? h(
                  'select',
                  { ...common },
                  field.options.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)),
                )
              : h('input', { ...common, type: field.kind === 'number' ? 'number' : 'text', spellCheck: false })

      return h(
        'div',
        { style: S.row },
        field.kind === 'bool'
          ? h('div', { style: S.check }, control, h('label', { style: S.label }, field.label))
          : h('label', { style: S.label }, field.label),
        field.kind === 'bool' ? null : control,
        field.hint ? h('span', { style: S.hint }, field.hint) : null,
      )
    }

    function StatusPanel() {
      const [status, setStatus] = useState({ state: 'loading' })
      useEffect(() => {
        let cancelled = false
        const tick = async () => {
          try {
            const response = await fetch(STATUS_ENDPOINT, { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (!cancelled) setStatus({ state: 'ready', data: body.diagnostics ?? {} })
          } catch (error) {
            if (!cancelled) setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
          }
        }
        tick()
        const timer = setInterval(tick, 15000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [])

      if (status.state === 'loading') return h('div', { style: S.note }, '正在读取运行状态…')
      if (status.state === 'error') return h('div', { style: S.note }, `运行状态不可用：${status.message}`)
      const d = status.data ?? {}
      if (!d.appId && !d.channels) return h('div', { style: S.note }, '插件尚未挂载（可能刚重载或未启用）。')
      const marks = { ready: '✅', disabled: '❌', starting: '⏳', restarting: '⏳', unknown: '❔' }
      const label = (key) => (key === 'im.message.receive_v1' ? '消息接收' : key === 'card.action.trigger' ? '卡片按钮' : key)
      const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '还没有收到过')
      return h(
        'div',
        { style: S.note },
        h('div', { style: S.label }, '运行状态'),
        h('div', { style: S.hint }, `应用 ${d.appId ?? '未知'}${d.workspace ? ` @ ${d.workspace}` : ''} · 白名单 ${d.allowList ?? 0} 人 · 已绑定聊天 ${d.bindings ?? 0}`),
        h(
          'div',
          { style: S.hint },
          (d.channels ?? []).map((c) => `${marks[c.state] ?? '❔'} ${label(c.key)}`).join('　'),
        ),
        h('div', { style: S.hint }, `入站 ${d.inboundCount ?? 0} 条 · 最近 ${when(d.lastInboundAt)} · 发送失败 ${d.outboundFailures ?? 0}`),
      )
    }

    function Guidance() {
      return h(
        'details',
        { style: { marginTop: 6 } },
        h('summary', { style: S.label }, '配置引导（机器人 / lark-cli）'),
        h(
          'div',
          { style: S.wrap },
          h('span', { style: S.hint }, '1) 查看当前绑定的应用与机器人身份：'),
          h('code', { style: S.code }, 'lark-cli auth status'),
          h('span', { style: S.hint }, '2) 换成别的应用（密钥进系统钥匙串，不落 DSH）：'),
          h('code', { style: S.code }, 'lark-cli config init --app-id cli_xxx --app-secret-stdin'),
          h('span', { style: S.hint }, '3) 开放平台需要开：机器人能力、事件订阅=长连接、事件 im.message.receive_v1、权限 im:message.p2p_msg:readonly / im:message:send_as_bot / im:resource'),
          h('span', { style: S.hint }, '4) 首次使用：给机器人发一条消息，再到 ~/.dsh/feishu-bridge/bridge.log 搜 rejected-unpaired，把 open_id 填进白名单。'),
        ),
      )
    }

    function Page({ view }) {
      const [state, setState] = useState({ status: 'loading' })
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')

      useEffect(() => {
        let cancelled = false
        ;(async () => {
          try {
            const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const body = await response.json()
            if (cancelled) return
            setState({ status: 'ready', config: body.config ?? {} })
            setDraft(draftOf(body.config ?? {}))
          } catch (error) {
            if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [])

      if (state.status === 'loading') return h('div', { style: S.note }, '正在读取配置…')
      if (state.status === 'error') {
        return h('div', { style: S.note }, `读取配置失败：${state.message}（宿主未挂载 ${ENDPOINT} 时会出现这个提示）`)
      }

      const config = state.config ?? {}
      if (view === 'summary') {
        const count = Array.isArray(config.allowOpenIds) ? config.allowOpenIds.length : 0
        return h('span', { style: S.hint }, `工作目录 ${config.cwd || '未设置'} · 白名单 ${count} 人`)
      }

      const dirty = draft ? FIELDS.filter((field) => changed(field, draft[field.key], config[field.key])) : []

      const save = async () => {
        if (!draft || dirty.length === 0) return
        setBusy(true)
        setMessage('')
        const payload = {}
        for (const field of FIELDS) payload[field.key] = normalized(field, draft[field.key])
        try {
          const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body?.message ?? `HTTP ${response.status}`)
          const refreshed = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          const latest = refreshed.ok ? await refreshed.json() : { config: payload }
          setState({ status: 'ready', config: latest.config ?? payload })
          setDraft(draftOf(latest.config ?? payload))
          setMessage('已保存并重载桥接。')
        } catch (error) {
          setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: S.wrap },
        h(StatusPanel),
        h('div', { style: S.note }, '通道：本机 lark-cli 的长连接（bot 身份）。机器人 = lark-cli 所绑定飞书应用的那个机器人。保存后桥接会立即按新配置重载。'),
        ...FIELDS.map((field) =>
          h(FieldRow, {
            key: field.key,
            field,
            value: draft?.[field.key] ?? '',
            onChange: (next) => setDraft({ ...draft, [field.key]: next }),
          }),
        ),
        h(
          'div',
          { style: S.actions },
          h('button', { type: 'button', style: S.button, disabled: busy || dirty.length === 0, onClick: save }, busy ? '保存中…' : '保存'),
          h('span', { style: S.hint }, dirty.length ? `有 ${dirty.length} 项待保存` : '没有改动'),
          message ? h('span', { style: S.hint }, message) : null,
        ),
        h(Guidance),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const Entry = (props) => h(Page, { view: props.view })
        try {
          ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY }, Entry))
        } catch (error) {
          console.warn('[feishu-bridge] row config registration failed', error)
        }
      },
    }
  },
})
