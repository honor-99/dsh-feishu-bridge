# 飞书 ↔ DeepSeek Harness 桥接插件

> Drive a local [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from Feishu/Lark.
> Bot long connection in, real DSH sessions behind it, identical transcript on both sides.
> No public IP, no tunnel, no separate bot server: it reuses your existing `lark-cli` authorization.

用飞书（手机/桌面）给本机的 DeepSeek Harness 发指令：飞书消息变成一个真实的 DSH 会话回合，
DSH 的回答、工具调用、结束状态实时回到飞书；因为走的是普通 Session，
**DSH Web UI 和飞书里看到的是同一份会话记录**。

- 入站：`lark-cli event consume im.message.receive_v1 --as bot`（WebSocket 长连接，无需公网 IP / 内网穿透）
- 出站：`lark-cli im +messages-send / +messages-reply --as bot`（markdown 消息）
- 会话：`ctx.sessionController.create / prompt / cancel / rename`，与网页端完全同一条链路
- 记录：DSH 侧是标准 `session.v4.jsonl.zstd` 会话日志；飞书侧是普通聊天记录
- 状态：`~/.dsh/feishu-bridge/state.json`（飞书会话 → DSH sessionId 的映射）

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | 插件入口：`apply(ctx, config)`、配置解析、生命周期 |
| `bridge.js` | 路由（聊天/话题 → 会话）、指令、会话事件镜像回飞书 |
| `lark.js` | 长连接消费者（断线指数退避重启）+ 一次性 CLI 调用 |
| `store.js` | 会话绑定持久化 |
| `util.js` | 日志、文本提取、分片 |
| `scripts/selftest.mjs` | 离线自测：伪造飞书事件、真实回写飞书 |

## 配置（`cordis.patch.yml` 的 `config`）

> 目前没有图形化配置表单：DSH 不会从 `Config` schema 自动生成表单，插件只有自带浏览器端模块并注册
> `plugins.row.config` 才会有「配置」入口。现阶段改配置 = 改这个 YAML（改完在「插件」面板关/开一次）。

| 键 | 说明 | 默认 |
| --- | --- | --- |
| `cwd` | 会话工作目录（决定 Agent 在哪干活，并复用该路径的 workspace） | 进程当前目录 |
| `allowOpenIds` | 允许操作的白名单（飞书 open_id）。**留空 = 拒绝所有人**，被拒的 open_id 写日志 | `[]` |
| `identity` | 出站身份，`bot` / `user` | `bot` |
| `nodePath` + `cliScript` | 可选：钉死某个 lark-cli 安装 | 空 = 自动探测 |
| `cliCommand` | 自动探测不到时使用的命令 | `lark-cli` |
| `groupSessions` | 群聊粒度：`thread`（话题各自一会话）/ `chat`（整群一个） | `thread` |
| `groupRequiresMention` | 群里是否必须 @ 机器人才响应 | `true` |
| `replyInThread` | 话题/回复串用 `--reply-in-thread` 回到原串 | `true` |
| `acknowledge` | 收到任务先回「⏳ 已收到」 | `true` |
| `showTools` | 是否把工具调用作为一行消息推到飞书 | `false` |
| `chunkLimit` | 单条飞书消息最大字符数 | `3200` |
| `feishuApprovals` | 把工具授权请求推到飞书并用 `/approve` 作答 | `true` |
| `approvalTimeoutMs` | 授权等待时长，超时按拒绝处理 | `600000`（10 分钟） |
| `feishuQuestions` | 接管 `ask_user` 的选项式提问 | `true` |
| `questionTimeoutMs` | 提问等待时长 | `600000` |
| `cardButtons` | 用交互卡片按钮代替打字选择 | `true` |
| `questionFreeText` | 卡片里附带“输入文字答案”输入框 | `true` |
| `attachments` | 接收飞书发来的图片与文件 | `true` |
| `welcome` | 首次绑定后发一条使用引导（换应用会重发） | `true` |
| `unpairedReply` | 未授权者在单聊里收到配对提示 | `true` |
| `stateDir` / `stateFile` / `logFile` | 状态与日志位置 | `~/.dsh/feishu-bridge/` |
| `agentPreset` | 指定 Agent 预设 | 宿主默认（`standard`） |
| `probeOnStart` | 启动自检（调试用，会真建一个会话） | `false` |

### lark-cli 自动探测

1. `nodePath` + `cliScript` 显式指定；
2. 只给 `cliScript` → 用本进程 node 执行；
3. `cliCommand`（默认 `lark-cli`）→ `where`/`which` 定位；若同目录存在
   `node_modules/@larksuite/cli/scripts/run.js`，直接 `node run.js ...`，绕开 cmd.exe 引号与中文问题。

## 会话映射规则

| 飞书 | DSH |
| --- | --- |
| 与机器人的单聊（p2p） | 一个 Session，长期复用 |
| 群里直接 @机器人 | 整个群共用一个 Session |
| 话题群里的某个话题 | 一个 Session（按 `thread_id` 区分） |
| 群里「回复」机器人的某条消息 | 仍留在原群会话（`root_id` 只用于发送定位） |

> 只有 `thread_id` 参与分键；`root_id` 是同一会话内的回复上下文，`message_id` 绝不参与分键。


## 工具授权（审批不再卡死）

DSH 的工具在需要授权时会经 `approval/request` waterfall 询问「应答者」。飞书发起的会话如果
没人应答，就会静默卡住。本插件监听同一 waterfall，只接管**属于飞书会话**的请求：

```
approval/request(req, next)
  ├─ req.agent.id 不在本插件的会话映射里 → next()   # 交回网页端等原有应答者
  └─ 是飞书会话 → 发飞书消息，等待 /approve | /reject
```

- 返回 `allowed-once` / `rejected` 即视为**认领**该请求（一次授权只管一次操作）
- 超时（`approvalTimeoutMs`，默认 10 分钟）→ 按 `rejected` 结束，并告知会话
- 请求被取消（`signal` abort）或桥接停止 → 按 `cancelled` 结束，不会悬挂
- 同一会话多个待办时，`/approve`、`/reject` 一次处理全部
- `feishuApprovals: false` 可整体关闭接管，退回由网页端应答

已验证（日志，自检构造的 `selftest.write` 请求）：

```
bridge.approval.requested session-3baf… fceba982 selftest.write
bridge.approval.settled   session-3baf… fceba982 allowed-once (user)
```

## 选项式交互：点按钮，或只回一个数字

授权和提问都支持「不打字」：

| 场景 | 现在可以怎么回 |
| --- | --- |
| 授权（`/approve` 提示） | 点卡片按钮，或直接回 `1`（允许）/ `2`（拒绝），也认 `y`/`n`/`同意`/`拒绝` |
| agent 选项式提问（`ask_user`） | 点卡片按钮，或直接回序号 `1`、`2`；多选回 `1,3`；没有选项就直接回文字 |

实现要点：

- 接管 `user-questions/request` waterfall，把 `questions[].options` 渲染成编号列表 + 卡片按钮，
  回复解析成 `{answers:[{id, selected:[label…], custom?}]}`（`selected` 用的是 **选项 label**）。
- 待答问题/待批授权会「占用下一条回复」：裸 `1` 优先回答它，而不是当成新任务发给模型；命令仍优先。
- 卡片按钮走 `card.action.trigger` 事件；回调里带 `value:{kind,id,decision|option}`。

### 卡片按钮需要先在控制台订阅回调

`card.action.trigger` 属于 **callback**（回调）类事件，必须在开放平台订阅才会投递。未订阅时
CLI 会直接报 `failed_precondition` 并退出——插件会记录一次
`lark.consume.disabled card.action.trigger needs a console callback subscription`，
**停止重试**，其余功能不受影响（数字回复照常可用）。

订阅方式：开放平台 → 你的应用 → 事件与回调 → 回调配置，添加 `card.action.trigger`，保存后**发布版本**。

### 卡片三处易错点（实机验证过）

1. **提交按钮**用 `form_action_type: "submit"`，不是 `action_type: "form_submit"`。
   写错不会报错，只是永远拿不到表单值。
2. **`form_value` 是 JSON 字符串**（形如 `"{\"qfree_text_<id>\":\"内容\"}"`），键是组件 `name`，
   不是对象，也不是 `action.form_value`。
3. **表单内组件不回传 `action_value`**，所以问题 id 编进了组件名
   （`qfree_text_<id>` / `qfree_submit_<id>`），靠 `action_name` 和 `form_value` 的键定位。

### 卡片空间的取舍（避免“显示不全”）

选项文字**不放按钮**（按钮是单行，必被截断），而是：

| 位置 | 内容 | 上限 |
| --- | --- | --- |
| 卡片正文 | 问题（截断时提示“完整内容见上方消息”） | 600 字符 |
| 卡片列表 | 全部选项 **完整 label + description**，自动换行 | 1800 字符 |
| 按钮 | 只有序号 `1` `2` `3`… | 永不截断 |
| 卡片脚注 | 有效期（默认 30 分钟） | — |
| 同条文本消息 | 完整选项与描述（受 `chunkLimit` 控制，可自动分片） | 4200 默认 |

按钮 `value.option` 里存的是**完整 label**，所以显示用短标签、作答用全文，两者不冲突。

> 已验证：提问链路 `bridge.question.requested → settled(2 → SQLite) → answers[{selected:["SQLite"]}]`；
> 卡片 consumer 在未订阅时按设计降级，不再刷重试日志。

## 重新配置 lark-cli（换应用 / 重授权 / 彻底重置）

先分清四种意图，命令完全不同：

| 意图 | 命令 | 影响 |
| --- | --- | --- |
| 只重新授权（token 过期、换个人用） | `lark-cli auth login` | 不动应用绑定 |
| 换一个新应用，旧的保留 | `lark-cli profile add` → `lark-cli profile use <name>` | 一个 workspace 下多 profile 并存 |
| 彻底重置当前绑定 | `lark-cli config remove` → `lark-cli config init --new` | 清空 token 与配置，需重新授权 |
| 只改身份策略（bot-only ↔ user-default） | `lark-cli config strict-mode` | 不必重新 bind |

### 换应用的标准流程

1. **开放平台**（新应用）：开机器人能力 → 事件订阅方式选**长连接** → 订阅 `im.message.receive_v1`
   （要按钮再加回调 `card.action.trigger`）→ 权限 `im:message.p2p_msg:readonly`、`im:message:send_as_bot`、`im:resource`
   → **发布版本**。
2. **本机绑定**：`lark-cli profile add`，或直接用参数
   `lark-cli config init --app-id cli_xxx --app-secret-stdin --brand feishu`（Secret 从 stdin 读，进系统钥匙串）。
3. **切换**：`lark-cli profile use <name>`（`use -` 切回上一个）。
4. **验证**：`lark-cli config show`（看 `appId` / `profile` / `workspace`）、`lark-cli auth status`（`bot: ready` 即可，
   本插件不用 user 身份）、`lark-cli doctor`。
5. **插件侧**：最多 2 分钟自动发现 appId 变化并 remount（日志 `bridge.app_switched`），并重发使用引导；
   想立刻生效就在「插件」面板关/开一次。
6. **必做一步**：`open_id` 是**应用级**的，换应用后旧白名单必然失效。给新机器人发一句话，
   按回执把那行 `ou_…` 填进白名单（保存立即生效，不用重启）。
7. 旧会话无需清理：`chat_id` 也是应用级的，新旧不会撞。想彻底清空就删
   `~/.dsh/feishu-bridge/state.json`（聊天↔会话绑定）和 `welcome.json`（引导标记）。

> 凭据不落插件：Secret 存在系统钥匙串（`appsecret:<appId>`），`config show` 只回显 `****`，
> 插件配置里没有任何 App Secret。

## 指令

| 输入 | 作用 |
| --- | --- |
| 任意文本 | 交给当前会话执行 |
| `/new` | 新建会话并绑定 |
| `/stop` | 取消当前回合 |
| `/approve` | 批准待处理的工具授权（仅本次） |
| `/reject` | 拒绝待处理的工具授权 |
| `/status` | 查看绑定会话、目录、运行状态、通道健康 |
| `/doctor` | 自检：应用与 workspace、白名单、绑定数、事件通道、入站统计、待处理、能力开关 |
| `/model` | 查看当前会话的模型；`/model <provider>/<model> [effort]` 切换（下一轮生效） |
| `/models` | 列出宿主暴露的 provider 与模型 |
| `/title <文本>` | 给当前会话改名（侧边栏可见） |
| `/cwd` | 查看当前工作目录 |
| `/sessions` | 列出最近会话 |
| `/resume <id>` | 绑定到已有会话 |
| `/help` | 帮助 |

## 安装

**适用 DSH 版本：`0.2.1-rc.5`（开发者预览期，插件 API 可能随版本变化）。**

**从 npm 安装（推荐）**

```bash
dsh plugin --profile web add @honor-99/dsh-feishu-bridge
```

如果装完后 bundle 未被自动选中，在 DSH 里用一次 `plugin_manager` 补上选择（它会同时完成安装与 bundle 选择）：

```
plugin_manager  action: install_bundle   target: @honor-99/dsh-feishu-bridge
```

**从 GitHub 安装**

```bash
git clone git@github.com:honor-99/dsh-feishu-bridge.git
```

```
plugin_manager  action: install_bundle   target: <克隆下来的绝对路径>
```

**本地开发**：同样用绝对路径安装。profile 里会记成 `link:<路径>`，改完源码重载插件即生效。

依赖：Node ≥ 22、`lark-cli`（1.0.96 已验证）、DSH host 侧 `sessionController` 与 `workspaceRegistry`。

安装后请改 `cordis.patch.yml`（或直接在插件配置页改）两个值：

```yaml
cwd: 'D:\path\to\your\project'        # 你的项目目录
allowOpenIds:
  - ou_REPLACE_WITH_YOUR_OPEN_ID      # 给机器人发任意消息，它会把这个值回给你
```

> 命名说明：npm 上 `dsh-feishu-bridge` 已被另一位作者占用（功能类似），本插件发布在
> `@honor-99/` 作用域下，两者不是同一个包。

## 已验证 / 未验证

已验证（真机）：

- 插件安装、`application: applied`、宿主内激活（日志 `plugin.mounted`）
- 双通道长连接稳定驻留：`ready event_key=im.message.receive_v1` / `card.action.trigger`
- 真实会话链路：飞书消息 → `sessionController.create/prompt` → `assistant/message` → `turn/end`，双端记录一致
- 出站 markdown 与交互卡片真实到达飞书
- 卡片回传：按钮点击（`allowed-once (card)`）与表单文字提交（`custom:"…"`）
- 授权链路经 `approval/request` waterfall 派发并被本插件认领（`{ prepend: true }`），未决时不会悬挂
- 选项式提问：序号回复、按钮点击、自由文本三种作答
- 图片：解析 `[Image: img_v3_…]` → 下载 → 内联 prompt；模型不支持视觉时自动降级为路径提示
- 配置页：`GET/POST /feishu-bridge/config` 读写 + `GET /feishu-bridge/status` 运行时快照

尚未覆盖：

- 群里**不 @** 也能响应（需要应用开通「获取群组中所有消息」权限，本仓库未做代码侧规避）
- 语音/视频内容理解（当前按文件落盘，交路径给 agent）
- 卡片在会话中被后续操作**就地更新**（飞书延迟更新 token 每次点击仅两次机会）

## 接收图片与文件

飞书把附件渲染成 `content` 里的标记（图片 `![Image](img_x)`、文件 `<file key="file_x" …/>`），
插件解析标记后按类型处理：

| 类型 | 处理 |
| --- | --- |
| 图片 | 下载后**内联进 prompt**（base64 image part），模型直接“看见”图；最多 4 张，单张 ≤18MB |
| 文件 / 音频 / 视频 | 下载到 `~/.dsh/feishu-bridge/incoming/<message-id>/`，把**绝对路径**写进 prompt，agent 用自己的文件工具去读 |

- 落盘位置固定，便于 agent 引用；也可用文本消息随时间清理该目录。
- 权限要求：`im:message:readonly`（bot 侧即 `im:message.p2p_msg:readonly`）+ `im:resource`。
  缺权限时下载会失败，插件回一句提示并记 `feishu.attachment.*.failed`。
- 不支持：贴纸（sticker）、文件夹（需先 `im files folder --recursive` 展开）。
- 开关：`attachments`（默认 `true`）。
- 图片消息可以配一句文字一起发，文字会作为 prompt 的开头。

## 排查

**先发 `/doctor`**（或看配置页顶部的「运行状态」面板）——它会一次列出：应用与 workspace、
白名单人数、绑定聊天数、两个事件通道的实时状态、累计入站与最近入站时间、待处理授权/提问数、
发送失败数、能力开关。绝大多数“没反应”都能在这一屏看出是哪一环。

| 现象 | 处理 |
| --- | --- |
| 飞书发消息没反应 | 先 `/doctor`：`消息接收` 不是 ready → 应用未发布/事件未订阅；是 ready 但入站数不涨 → 看白名单是否包含你的 open_id（`/doctor` 里能看到人数） |
| 收到「🔒 未授权」回执 | 把回执里那行 `ou_…` 加进白名单，保存即生效 |
| 反复 restart | 确认 `nodePath`/`cliScript` 指向本机真实的 node 与 `@larksuite/cli/scripts/run.js` |
| 通道卡在 `starting`/`restarting` | 常因上一实例的订阅泄漏：插件已改为**先关 stdin 优雅退出**（CLI 的官方停止信号）再兜底 kill，正常重载不会再残留 |
| 回复 `⚠️ 无法提交任务` | 通常是会话被归档：发 `/new` 重建 |
| 群里不响应 | 默认要求 @ 机器人；或把 `groupRequiresMention` 设为 false |
| 卡片按钮点了没反应 | 卡片已失效（超时/已作答）会回一句提示；未订阅回调时 `/doctor` 里 `卡片按钮` 显示 `disabled` |
| 机器人不是想要的号 | 换一个飞书自建应用（App ID/Secret），按「重新配置 lark-cli」一节切换 |

## 安全

- `allowOpenIds` 决定谁能遥控这台机器；留空等于任何能给机器人发消息的人都行。
- 会话默认权限是宿主当前策略（本机为 `workspace-write`），不会因为来自飞书而放宽。
- 状态文件与日志位于 `~/.dsh/feishu-bridge/`，只有本机用户可读。
- **配置端口做同源校验**：`POST /feishu-bridge/config` 要求 `content-type: application/json`、
  拒绝 `sec-fetch-site: cross-site`、并在带 `Origin` 时要求其 host 等于请求 `Host`。
  这样恶意网页无法用表单 POST（`text/plain` 也能带 JSON 体、且不触发预检）改写白名单。
  该路由不在宿主 `/api` 鉴权之后，这几项校验是它唯一的防线。

## 分发与收录

仓库：<https://github.com/honor-99/dsh-feishu-bridge>

- **插件市场收录**：给仓库加上 GitHub topic **`dsh-plugin`**，[dshfind](https://github.com/hikariming/dshfind)
  每天 02:17 UTC 自动同步，无需提 PR；
- 其他目录站：dshbase.com、dsh-plugins.tech、awesome-deepseek-harness（PR 一条即可）；
- **npm 发布（可选）**：包名目前是 `@local/dsh-feishu-bridge`（本地安装用）。若要发 npm，
  需改成公开名（如 `dsh-feishu-bridge`）并重装一次插件；`private` 也要去掉。

发布前自查：

1. 不提交 `node_modules/`、`package-lock.json`、`*.log`（`.gitignore` 已覆盖）；
2. `cordis.patch.yml` 里的 `cwd` 与 `allowOpenIds` 必须是占位值，不能是任何真实账号数据；
3. 白名单默认拒绝所有人，这是有意的安全默认值。

## 图形化配置（客户端半，待重启生效）

`client.js` 是浏览器半边：它把本插件行注册进 `plugins.row.config`
（键 `@local/dsh-feishu-bridge#feishu-bridge`），于是在「插件 → 飞书远程桥接 → 组件行」
上出现一个 **配置** 页，内含：

- 可编辑字段：`cwd`、`allowOpenIds`、`groupSessions`、群聊 @ 要求、回执、推送工具调用、
  字符上限、`agentPreset`、可选的 `nodePath`/`cliScript` 覆盖；
- 配置引导折叠块：`lark-cli auth status`、`config init`、开放平台需要开的事件与权限、
  以及「怎么找到自己的 open_id」（先发一条，再到日志里搜 `rejected-unpaired`）。

### 保存走哪条通道（重要）

宿主提供的 `form` 通道对本插件**不可用**：bundle 声明的行，其 settings 命名空间是
`include:feishu-bridge`（Loader 的 include 层前缀），而插件管理器按行 id `feishu-bridge`
调 `formFor(rowId)`，永远匹配不到，页面拿不到 `form`。因此改为插件自带通道：

| 组成 | 说明 |
| --- | --- |
| 路由 | `GET /feishu-bridge/config`、`POST /feishu-bridge/config`（`ctx.webServer.register`，prefix） |
| 存储 | `~/.dsh/feishu-bridge/config.json`，**覆盖** Loader 行 `config` 的运行时层；patch 仍是组合来源 |
| 生效 | POST 校验 + 落盘后立即 `remount`（停长连接 → 按新配置重连），无需重启宿主 |
| 页面 | 插件行「配置」页读取上述路由，字段改动后一次提交 |

已验证（`bridge.log`）：

```
config.selfcheck 200 {"config":{...}}                          # GET，真实 HTTP
config.selfcheck.post 200 {"saved":true,"overlay":{...}}       # POST 写入
bridge.remounted config write                                  # 热重载
plugin.mounted {"build":"b5","routes":1,"overlay":{...}}       # 重启后覆盖层被读回
bridge.started {"bindings":4}                                  # 长连接恢复
```

## 反馈与联系

- 问题与建议：<https://github.com/honor-99/dsh-feishu-bridge/issues>
- 邮箱：qwerhyc@163.com
- npm：<https://www.npmjs.com/package/@honor-99/dsh-feishu-bridge>

> 提交作者统一使用 GitHub 的 noreply 地址（`34311832+honor-99@users.noreply.github.com`），
> 因此提交历史中不出现真实邮箱；需要联系请用上面的地址。
