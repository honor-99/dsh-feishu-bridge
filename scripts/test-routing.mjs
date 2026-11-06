/** Routing regression test: no network, no CLI, just the bridge's own logic. */
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { FeishuBridge } from '../bridge.js'
import { ChatStore } from '../store.js'

const dir = path.join(os.tmpdir(), `feishu-bridge-routing-${Date.now()}`)
const created = []
const prompted = []

const ctx = {
  sessionController: {
    create: async () => {
      const sessionId = `session-test-${created.length + 1}`
      created.push(sessionId)
      return { sessionId }
    },
    prompt: async (request) => {
      prompted.push(request)
      return { accepted: true }
    },
    cancel: () => ({}),
    list: async () => ({ items: [] }),
    rename: async () => ({}),
  },
  on: () => () => {},
  get: () => undefined,
}

const config = {
  cwd: 'D:\\dsh',
  allowOpenIds: ['ou_me'],
  identity: 'bot',
  groupSessions: 'thread',
  groupRequiresMention: true,
  replyInThread: true,
  acknowledge: false,
  showTools: false,
  chunkLimit: 3200,
  stateDir: dir,
  stateFile: path.join(dir, 'state.json'),
  logFile: path.join(dir, 'test.log'),
}

const sent = []
const lark = {
  startConsume: () => {},
  stop: async () => {},
  call: async (args) => {
    sent.push(args)
    return { ok: true }
  },
}

const log = () => {}
const store = new ChatStore(config.stateFile)
const bridge = new FeishuBridge({ ctx, config, store, lark, log })

const event = (overrides) => ({
  type: 'im.message.receive_v1',
  sender_type: 'user',
  sender_id: 'ou_me',
  message_type: 'text',
  content: 'hi',
  ...overrides,
})

// 1) same p2p chat, three messages -> one session
for (const id of ['m1', 'm2', 'm3']) {
  await bridge.onFeishuEvent(event({ message_id: id, chat_id: 'oc_p2p', chat_type: 'p2p' }))
}
assert.equal(created.length, 1, 'p2p must reuse one session')

// 2) group, two top-level @ messages with no thread -> still one session
await bridge.onFeishuEvent(
  event({ message_id: 'g1', chat_id: 'oc_group', chat_type: 'group', mentions: [{ id: 'ou_bot', key: '@_user_1' }] }),
)
await bridge.onFeishuEvent(
  event({ message_id: 'g2', chat_id: 'oc_group', chat_type: 'group', mentions: [{ id: 'ou_bot', key: '@_user_1' }] }),
)
assert.equal(created.length, 2, 'group top-level messages must reuse one session per chat')

// 3) group topic messages -> one session per thread, and replies stay in it
await bridge.onFeishuEvent(
  event({ message_id: 't1', chat_id: 'oc_group', chat_type: 'group', thread_id: 'omt_a', mentions: [{ id: 'ou_bot' }] }),
)
await bridge.onFeishuEvent(
  event({ message_id: 't2', chat_id: 'oc_group', chat_type: 'group', thread_id: 'omt_a', mentions: [{ id: 'ou_bot' }] }),
)
await bridge.onFeishuEvent(
  event({ message_id: 't3', chat_id: 'oc_group', chat_type: 'group', thread_id: 'omt_b', mentions: [{ id: 'ou_bot' }] }),
)
assert.equal(created.length, 4, 'each distinct thread must own exactly one session')

// 4) group reply to a bot message (root_id only, no thread) stays in the chat session
await bridge.onFeishuEvent(
  event({
    message_id: 'g4',
    chat_id: 'oc_group',
    chat_type: 'group',
    root_id: 'om_root_of_bot_message',
    mentions: [{ id: 'ou_bot' }],
  }),
)
assert.equal(created.length, 4, 'a reply inside the same group chat must not fork a session')

// 5) group message without a mention is ignored
const before = prompted.length
await bridge.onFeishuEvent(event({ message_id: 'g3', chat_id: 'oc_group', chat_type: 'group' }))
assert.equal(prompted.length, before, 'unmentioned group message must be ignored')

// 5) p2p chat 'chat' scope: groupSessions=chat collapses topics into the chat session
const store2 = new ChatStore(path.join(dir, 'state2.json'))
const bridge2 = new FeishuBridge({ ctx, config: { ...config, groupSessions: 'chat' }, store: store2, lark, log })
const createdBefore = created.length
await bridge2.onFeishuEvent(event({ message_id: 'c1', chat_id: 'oc_g2', chat_type: 'group', thread_id: 'omt_x', mentions: [{ id: 'b' }] }))
await bridge2.onFeishuEvent(event({ message_id: 'c2', chat_id: 'oc_g2', chat_type: 'group', thread_id: 'omt_y', mentions: [{ id: 'b' }] }))
assert.equal(created.length - createdBefore, 1, 'chat scope must collapse every thread into one session')

console.log(JSON.stringify({ ok: true, created, prompts: prompted.length, sent: sent.length }, null, 2))
