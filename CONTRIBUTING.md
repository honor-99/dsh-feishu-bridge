# 贡献与维护指南

本仓库有两个身份，改代码前必须先分清：

| 身份 | 说明 |
| --- | --- |
| **npm 包 / DSH bundle** | 发布到 `@honor-99/dsh-feishu-bridge`，供他人 `dsh plugin add` 安装 |
| **本机正在运行的插件目录** | 本机 profile 里是 `link:D:/dsh/feishu-bridge`，即**这个目录本身**就是运行时 |

所以：**改本地文件 = 改线上插件**。`git checkout`、`git pull`、切换分支都会直接影响正在跑的桥接。

---

## 1. 改动生效的边界

| 改动 | 生效方式 | 备注 |
| --- | --- | --- |
| `index.js` / `bridge.js` / `lark.js` / `store.js` / `util.js`（Host 半） | 插件面板**关一次再开**，或重载插件 | 重载会短暂断开飞书长连接（约 2–5 秒） |
| `client.js`（浏览器半） | **刷新页面**（Ctrl+Shift+R） | 客户端模块图在宿主启动时扫描，新增 `dsh.client` 声明需要重启宿主 |
| `cordis.patch.yml` | 重装 bundle，或重启宿主 | 本 profile 的 `patchReload` 是 `startup` |
| `package.json` 的 `name` | 必须**卸载后重装** | profile 依赖键与 bundle row 的 `name` 必须同时改 |
| `locale/*.json`、`icon.svg` | 刷新页面 / 重载插件 | 仅影响插件面板显示 |

重载期间**内存中的待批授权会作废**（插件会主动往会话推一条提示）。所以：**不要在有未决授权时重载**。

## 2. 运行时状态不在仓库里

| 路径 | 内容 | 是否提交 |
| --- | --- | --- |
| `~/.dsh/feishu-bridge/config.json` | 插件配置**覆盖层**（`cwd`、`allowOpenIds`、各开关） | ❌ 绝不 |
| `~/.dsh/feishu-bridge/state.json` | 飞书聊天 → DSH sessionId 绑定 | ❌ 绝不 |
| `~/.dsh/feishu-bridge/bridge.log` | 运行日志 | ❌ 绝不 |
| `~/.dsh/feishu-bridge/incoming/` | 收到的附件落盘 | ❌ 绝不 |
| `cordis.patch.yml` | **只有占位值**：`D:\path\to\your\project`、`ou_REPLACE_WITH_YOUR_OPEN_ID` | ✅ 提交占位版本 |

真实配置永远走覆盖层，因此仓库里的 `cordis.patch.yml` 必须是脱敏的。

## 3. 本地开发循环

```powershell
# 1. 改代码
# 2. 静态检查（无需联网、无外部依赖）
node --check index.js; node --check bridge.js; node --check lark.js
# 3. 路由回归测试（断言式，覆盖 p2p/群/话题/未授权/chat 粒度）
npm test
# 4. 重载插件，然后看日志确认挂载与通道
Get-Content "$env:USERPROFILE\.dsh\feishu-bridge\bridge.log" -Tail 20
```

日志里的健康判据（缺一不可）：

```
plugin.mounted {..., "routes":1}
[event] ready event_key=im.message.receive_v1
[event] ready event_key=card.action.trigger
```

真实出站自测（会**真的发飞书消息**，需谨慎）：

```powershell
npm run selftest -- oc_你的chat_id
```

它会伪造一个飞书事件、走真实 `lark-cli` 回写，用完请自行删除那条测试消息。

## 4. 提交约定

- 提交信息用 Conventional Commits 前缀：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`
- 一个提交只做一件事；**不要**把格式化、重命名、功能混在一条里
- 提交前跑 `npm test` 与 `node --check`
- 提交前确认没有带出：真实 `ou_`/`oc_`/`om_`、真实 `cli_` 应用 ID、本机绝对路径、令牌

自查命令：

```powershell
Select-String -Path *.js,*.yml,*.json,scripts/*.mjs,README.md -Pattern 'ou_aba','oc_','cli_a92','C:\\Users','npm_'
```

## 5. 发布流程（三连）

版本号与 git tag 必须与 npm 上的 `gitHead` 三方对齐。标准动作只有三条：

```powershell
cd D:\dsh\feishu-bridge

# 1) 升版本：改 package.json + 自动提交 + 自动打 vX.Y.Z 附注标签
npm version patch        # bugfix：0.1.1 → 0.1.2
# npm version minor      # 新功能：0.1.x → 0.2.0
# npm version major      # 破坏性变更：1.0.0

# 2) 发布（本机默认 registry 是 npmmirror 只读镜像，必须显式指定官方源）
npm publish --registry=https://registry.npmjs.org

# 3) 推提交与标签（本仓库已配 core.sshCommand 走 443 端口，无需额外参数）
git push --follow-tags
```

**不要手打 `git tag`**：`npm version` 会同时改 `package.json`、提交、打标签，避免版本号与标签不一致。

### 发布后校验

```powershell
$r='https://registry.npmjs.org'
npm view @honor-99/dsh-feishu-bridge@latest version gitHead --registry=$r
git log --oneline -1                     # 应与上面的 gitHead 是同一个提交
git ls-remote --tags origin              # 应看到对应的 vX.Y.Z
```

### 发布通道的两个坑

1. **2FA**：npm 强制发布时校验。用「绕过 2FA 的 Granular Access Token」写入
   `~/.npmrc` 的 `//registry.npmjs.org/:_authToken`，之后无需 `--otp`。
2. **E409 `Cannot publish over previously staged version`**：发布中途失败（如 2FA 未通过）
   会在服务端留下 staged 占位版本，`npm stage list` 看不到、也无法清理。
   **唯一解法是升版本号**再发（这就是为什么首个公开版本是 `0.1.1` 而不是 `0.1.0`）。
   遇到它不要反复重试同一个版本号。

### 版本语义

- `patch`：修 bug、改文案、改默认值
- `minor`：新增指令/配置项/能力，保持兼容
- `major`：改了 `state.json` 结构、`config.json` 键名语义，或需要用户手动迁移的行为

`: patch` 之外的变更，请在 `CHANGELOG` 段落（或 Release Notes）说明迁移动作。

## 6. 目录站收录

收录只认 **GitHub topic `dsh-plugin`**，不需要提交表单：

- [dsh-plugin.org](https://dsh-plugin.org/)：爬虫扫描该 topic，初始状态 `unconfirmed`，人工核对后转 `verified`
- [dshfind](https://github.com/hikariming/dshfind)：每天 02:17 UTC 同步同一 topic

**不要删除 `dsh-plugin` topic**，否则会被判为下架。收录前请确保 README 里的安装命令可用
（包名必须与 npm 上真实存在的名字一致）。

## 7. 已知限制（不要当成 bug 报告）

- **群里不 @ 不说话**：飞书只在被 @ 时把群消息推给机器人；要收全部群消息需应用开通
  「获取群组中所有消息」(`im:message.group_msg`) 并发布版本。这是平台侧配置，不是代码问题。
- **图片在纯文本模型上不可内联**：宿主会在 admission 阶段拒绝，插件自动降级为「落盘 + 给路径」。
- **卡片失效无法远程关闭**：无论哪端后作答，另一端已弹出的界面无法撤回（飞书的延迟更新令牌
  每次点击仅两次机会）。
- **重载即作废待批授权**：内存态，无法持久化。
