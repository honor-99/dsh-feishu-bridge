/**
 * Offline bridge self-test: feeds fabricated Feishu events into the real bridge
 * with a stubbed sessionController, while the outbound side is the REAL
 * lark-cli, so the resulting Feishu messages are observable.
 *
 *   node scripts/selftest.mjs <chat_id>
 */
import path from 'node:path'
import os from 'node:os'
import { FeishuBridge } from '../bridge.js'
import { LarkClient } from '../lark.js'
import { ChatStore } from '../store.js'
import { createLogger } from '../util.js'

const chatId = process.argv[2]
if (!chatId) {
  console.error('usage: node scripts/selftest.mjs <chat_id> [open_id]')
  process.exit(1)
}
// Optional: a real open_id, only used to build the fabricated event. Any value
// works because the stub below answers regardless of authorization.
const openId = process.argv[3] ?? 'ou_selftest_placeholder'

const dir = path.join(os.tmpdir(), 'feishu-bridge-selftest')
const log = createLogger(path.join(dir, 'selftest.log'))
const store = new ChatStore(path.join(dir, 'state.json'))

const calls = []
const sessions = {
  create: async (request) => {
    calls.push(['create', request])
    return { sessionId: 'session-selftest' }
  },
  prompt: async (request) => {
    calls.push(['prompt', request])
    return { accepted: true }
  },
  cancel: () => ({ accepted: true }),
  list: async () => ({ items: [{ sessionId: 'session-selftest', updatedAt: Date.now(), running: false }] }),
}

const ctx = {
  sessionController: sessions,
  on: () => () => {},
  get: () => undefined,
}

const config = {
  // Empty means "auto-detect lark-cli on PATH", same as the plugin at runtime.
  // Set LARK_CLI_NODE / LARK_CLI_SCRIPT to pin an exact installation.
  nodePath: process.env.LARK_CLI_NODE ?? '',
  cliScript: process.env.LARK_CLI_SCRIPT ?? '',
  cliCommand: 'lark-cli',
  identity: 'bot',
  cwd: process.cwd(),
  workspaceTitle: 'Feishu',
  allowOpenIds: [openId],
  groupRequiresMention: true,
  replyInThread: true,
  acknowledge: true,
  showTools: false,
  chunkLimit: 3200,
  stateDir: dir,
  stateFile: path.join(dir, 'state.json'),
  logFile: path.join(dir, 'selftest.log'),
}

const lark = new LarkClient(config, log)
const bridge = new FeishuBridge({ ctx, config, store, lark, log })

const base = {
  type: 'im.message.receive_v1',
  sender_type: 'user',
  sender_id: openId,
  chat_id: chatId,
  chat_type: 'p2p',
  message_type: 'text',
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  console.log('1) /help command')
  await bridge.onFeishuEvent({ ...base, message_id: 'om_smoke_help', content: '/help' })
  await sleep(1500)

  console.log('2) plain task -> create + prompt')
  await bridge.onFeishuEvent({ ...base, message_id: 'om_smoke_task', content: '在 D:\\dsh 下创建一个 hello.txt' })
  await sleep(1200)

  console.log('3) mirrored assistant message + turn end')
  const session = { id: 'session-selftest' }
  bridge.onSessionEvent(session, {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '**自测**：助手消息已通过真实 lark-cli 回到飞书。' }] }, stream: [] },
  })
  bridge.onSessionEvent(session, {
    type: 'turn/end',
    seq: 2,
    time: Date.now(),
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  await sleep(2500)

  console.log('calls:', JSON.stringify(calls, null, 2))
  console.log('bindings:', JSON.stringify(store.list(), null, 2))
} catch (error) {
  console.error('selftest failed:', error)
  process.exitCode = 1
} finally {
  await bridge.stop()
}
