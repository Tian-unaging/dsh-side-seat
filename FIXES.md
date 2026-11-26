# 修复记录

v1.0.0 → v1.0.3。

- 1–5：代码审查发现。
- 6–8：**真机安装后才暴露**（模拟宿主放过了它们）。
- 9–12：**真机点击后暴露**（会话打开链路与日志格式）。

依据全部来自本机 DeepSeek Harness 0.2.2-rc.5 的运行时契约与随包源码。

---

## 1 · WebServer 路由缺 `kind`（阻断：界面连不上宿主）

`src/bridge.js`。真实 `WebRoute = { kind:'exact'|'prefix', path, handler }`，原代码三个尝试都不带 `kind`。
改为先 `prefix` 再 `exact`。真机结果：`/api/side-seat/*` 返回插件自己的 403（信任闸门），而非 SPA 的 404。

## 2 · `agents.resume` 字段名错误

`src/session.js`：`{ sessionId }` → `{ resumeSessionId }`（真实 `ResumeAgentOptions`）。

## 3 · 人格段形状不对

`src/session.js`。真实 `PromptSection = { name, order, text }`，原来传 `render` / `content`。

## 4 · 主动发言写进会话的数据形状不对

`src/speak.js`。真实 `assistant/message` 数据是 `{ turn, step, message, stream }`，
`source.kind` 必须是 `model`，`stream` 记录必须是 `{type:'text-chunks', time0, index, dt[], texts[]}`。

> 附带纠正：早先判断「`agent.session` / `agent.followup` 不存在」是**误判**，`ReactLoopAgent` 上两者都是 public。

## 5 · 测试桩用旧形状

`test/selfcheck.mjs` 的假实现读 `def.render?.()`，改为按契约读 `def.text`。

---

## 6 · `output.schema` 用了非法类型（阻断：四个工具全部注册失败）

```js
schema: { type: 'json' }   // 真实 JsonSchemaType 没有 'json'
```

注册器拒绝 → 被 `catch` 吞掉 → 四个工具一个都没注册上，界面上只表现为「没有工具」。
改为合法的对象 schema。真机结果：修复后四个工具立刻出现在运行时工具表。

## 7 · 默认视觉模型路由是硬编码猜的（阻断：所有看图调用失败）

`visionModel = 'llm:deepseek-flash'` → `no adapter registered for provider "llm"`。
本机真实 provider 是 `deepseek-account`。改为**留空即自动探测**：遍历 `llm.listProviders()` →
`listModels()`，取第一个 `inputModalities` 含 `image` 的模型并缓存；设置里仍可手填覆盖。

## 8 · 工具注册失败被静默吞掉

原 `catch` 只写 stderr，桌面版用户看不见。改为有失败时写 `plugins-data/side-seat/tools-register.json`。

---

## 9 · 会话建出来了，界面没跳过去（「点了没反应」）

`client.js` 的 `openSessionInUi` 试了一批 `ctx.sessions.open` / `select` 之类的方法——**全都不存在**。
真实导航 API 是 **`ctx.uiWorkspace.openSession(target)`**（本机 client 服务目录核实），
`ctx.sessions` 只是 retain/headless。补上 `uiWorkspace.openSession` 为第一候选后，点击能正常跳转。

## 10 · 自定义 agent preset 是个空壳（会话有壳无引擎）

注册的是 `{ id, title, description }`，而真实 `PresetDefinition` 的 **`plugins`（composition）是必填**。
用它创建的会话有会话壳、没有模型和工具，界面全死。

改为**不注册自定义 preset**：走宿主默认 composition；人格仍由 systemPrompt section 注入。
真机结果：新会话可正常输入、发送、点击。

## 11 · 新会话不带工作区（每次都问「选择工作区」）

`agents.create` 时补 `meta.cwd`：优先复用当前任何活着会话的 `session.header.cwd`。
真机结果：不再询问工作区。

## 12 · 主动发言用 append 会写坏会话日志（**最严重**）

真机日志给出决定性证据：

```
resume failed: stored log is corrupt: SessionFormatError:
  assistant/message does not match an open turn and step
```

直接 `session.append('assistant/message', …)` 在**没有开启 turn/step** 时写出的事件，
当场能显示，但会话日志从此 corrupt —— **该会话再也无法 resume**，每次重载只能新建。

影响两处：

- 开场白（原实现）→ 改为**客户端渲染**，完全不碰会话日志。
- 实时陪看的主动发言 → `speakPath` 默认值从 `auto` 改为 **`overlay`**；
  `auto` 的候选序列里也移除了 `append`（保留该选项仅作排障，且已注明风险）。

同时 `selfcheck` 增加断言：观察循环**不得** append assistant/message。

---

## 文案与识别度

- 删除「不替你操作，不替你看完，只在同一边。」（README / 包描述 / locale / 人格提示词 / 界面）。
  换成平实一句：**看着你的屏幕陪你一起看；你叫它看什么，它就去看一眼。**
- 开场白改为 **「你好，我是旁座。」**（客户端卡片，空白会话里显示，2 分钟后或一开口就消失）。
- 侧边栏会话行加椅子图标：`sidebar.session.row.leading` 的 ownerProps 是 `{ sessionId }`，
  只给旁座自己的会话挂，不碰别人的行。

---

## 验证结果

| 套件 | 结果 |
|---|---|
| `node test/selfcheck.mjs` | **39 passed, 0 failed** |
| 严格契约模拟宿主 `sim/run.mjs` | **36 / 36 通过** |

真机验证（0.2.2-rc.5 / Windows）：

| 项 | 结果 |
|---|---|
| 安装 / Config | `applied`，状态 `schema` |
| 4 个工具 | ✅ 在运行时工具表，可调用 |
| `side_seat_profile` 读 / 写 / 跨重载保留 | ✅ |
| 截屏 | ✅ 后端 C（常驻 PowerShell）；后端 A 在 Desktop 下不可用（Host 是 Electron 子进程）；后端 B 本机无 ffmpeg |
| 视觉理解 | ✅ 自动探测 `deepseek-account:deepseek-flash`，实际读出屏幕内容 |
| 侧边栏入口 / 设置页 / 会话行图标 | ✅ active |
| 点击入口 → 打开会话 | ✅ 跳转、无需选工作区 |
| 开场白 | ✅ 客户端卡片 |

---

## 已知偏差

| 项 | 现状 | 说明 |
|---|---|---|
| 记忆没进 `ctx.storage` | `storage: "file"` | `defineDomain` 依赖 `@deepseek-ai/dsh-storage-domain` 动态 import，该 peer 在 profile 里解析不到 → 回退 `plugins-data/side-seat/memory.json`。功能可用且跨重启保留。 |
| 屏幕捕获只剩一个后端 | 依赖后端 C | 文档里「后端 A 首选」的假设不成立：Desktop 下 Host 不在 Electron 进程内。 |
| 会话间主动发言 | 目前只有 overlay | `followup` 会留下一条用户没打过的内部提示，`append` 会写坏日志。要在聊天流里自然出现，需要宿主提供「合成一轮」的正规入口。 |
| 实时陪看循环 / 系统音频 / 听写引擎 | 未实测 | 需要真实交互或外部服务。 |
| 残留空会话 | 需手动归档 | 第 12 条修好之前创建的旁座会话日志已损坏，无法 resume；在侧边栏归档即可。 |

---

## 13 · 会话没有模型，任何一轮都失败

真机报错：

```
本运行失败  agent "…" has no provider/model:
  set AgentOptions.provider and AgentOptions.model or record a model selection
```

`agents.create` 没给 `agentOptions`，这个会话的**每一轮**都会失败（不只是问候）。
修复：创建与恢复都显式带上模型 —— 优先复用当前任何活着的会话正在用的
`session.requestContext()` / `requestHeader().config`，拿不到再退回 `llm` 服务里的第一个模型。

## 14 · 开场白方案定稿：客户端卡片（方案 B）

宿主没有「助手凭空发起一轮」的接口，而两条捷径都不成立：

- `session.append('assistant/message')` → 会话日志 corrupt（见第 12 条）；
- `agent.followup(userMessage('你好'))` → 会在记录里留下一条**用户没说过的话**。

最终选 B：开场白由客户端在**空白会话**里渲染成一张卡片（「你好，我是旁座。」），
不写任何对话记录；用户打出的第一句就是真正的第一轮。
代价是那个空白会话仍显示宿主的「新建会话」初始页——平台行为，插件改不了。

同时移除了 `speak.greet()`，避免留一段没人调用的死代码。

---

## 15 · 视觉路由「取第一个能看图的模型」= 把整块能力锁死在失效路线上（**阻断**）

真机（0.2.2-rc.5 / Windows / 另一个装了官方 route 的 profile）实测：`side_seat_look`
每次都是

```
模型报错：Authentication Fails, Your api key: ****1aa7 is invalid
```

根因链：

1. `dsh-base/cordis.patch.yml` 里 `llm-deepseek`（provider `deepseek-official`，读
   `DEEPSEEK_API_KEY`）排在 `llm-deepseek-account` **之前**；
2. `resolveRoute()` 按 `listProviders()` 顺序取**第一个**声明 `image` 的模型并缓存，
   于是选中了官方 api-key 路线，而该 key 已失效；
3. `deepseek-account` 路线从不回退到 API key，所以真正可用的路线一次都没被试过。

验证方法（决定性）：临时把 `visionModel` 指成 `deepseek-account:deepseek-flash`，
同一个 `look` 立刻成功并读出了屏幕内容 —— 说明不是截屏、不是附件、不是模型能力问题。

修复（`src/vision.js`）：

- 自动探测改成**候选列表**：每个 provider 各取一个能看图的模型，不只看第一个命中的；
- `ask()` 按候选顺序试，**认证类失败**（`AUTH` / `*_CREDENTIAL` / `ACCOUNT_*` /
  `MODEL_NO_VISION` 等）换下一条；配额、限流、网络错误不换路（换也没用）；
- 成功的路由记住并排到最前，下次不再先撞一次墙（失效路线的每次尝试都是一次真实 API 调用）；
- 显式写了 `providerId:modelId` 时**不换路**，忠实报错；
- 所有模型错误都带上路由 id，例如 `模型报错（deepseek-official:deepseek-flash）：…`，
  否则用户只知道「密钥无效」，不知道是哪条路线；
- 图片附件只登记一次，回退不重复写；
- 诊断里多了 `visionRoute`，设置页「状态」能直接看到当前走哪条路由。

## 16 · ffmpeg 只认 PATH，漏掉 DSH 自己的两个落点

`side_seat_caption` / `side_seat_review` 报「本机没有找到 ffmpeg」，但本机其实有两份：

- `~/.dsh/tools/ffmpeg/bin/ffmpeg.exe`（初始化类插件部署的）
- `~/…/.dsh/profiles/<profile>/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe`

原来的候选表只有 PATH、`plugins-data/side-seat/bin`、WinGet、`C:\ffmpeg\bin`、scoop。

修复（`src/media.js`）：候选表补上 `$DSH_HOME/tools/ffmpeg/bin` 与
`$DSH_PROFILE_DIR/node_modules/@ffmpeg-installer/<platform>-<arch>`；
找不到时的提示也改成「PATH、~/.dsh/tools、profile 的 @ffmpeg-installer 都没有」并指向设置页的安装按钮。

> 副作用（符合设计顺序 A→B→C）：ffmpeg 一旦能找到，截屏后端会从 C（常驻 PowerShell）
> 切到 B（ffmpeg gdigrab）。实测可用，帧率与延迟都正常。

## 17 · `bond` 读得到、改不了的字段

`side_seat_profile` 返回的 bond 里有 `speakBudgetPerHour`，但 `PATCH_SCHEMA.bond`
没列它 —— update 时被静默忽略（返回「忽略了不在 schema 内的字段」）。
修复：`speakBudgetPerHour` 接受 0–240 的整数（也接受数字字符串），越界夹紧，布尔/空值拒收。

## 18 · 两处「报错文案会骗人」的小毛病

- `side_seat_review`：模型偶发只吐推理、不吐正文（复现：4 秒纯色测试片 `raw len=0`），
  原来会显示「（模型没有写出任何带出处的句子）」，把「模型没说话」说成「句子没出处」。
  改为：空返回先重试一次（预算 ×1.6），仍空则明确说「模型这次没有返回内容，可以再试一次」；
  日志同时记 `usage`，方便判断是被 maxTokens 截断还是模型没理人。
- 侧边栏入口：点开面板会顺手 `ensureSession()`，只想看一眼状态也会在多出一个空会话。
  改为打开面板不建会话，建会话留给「打开旁座会话」按钮与「开始看屏幕」。

## 验证结果（本轮）

| 套件 | 结果 |
|---|---|
| `node test/selfcheck.mjs` | **57 passed, 0 failed**（新增 15 条：路由回退 / 路由钉住 / 显式不换路 / 错误带路由 / ffmpeg 两处落点 / bond 字段） |
| 真机安装 | `application: applied`，路由 21/21，工具 4 个，客户端插槽 6 个 active |
| 真机功能 | `look screen` ✅（无需任何配置覆盖，自动回退到可用路由）、`look file` 图片 ✅、`caption` ✅（找到 ffmpeg 后正常出 csv）、`review` ✅（真片带出处）、`profile` 读写 ✅、`memory` 跨调用保留 ✅ |
| 安全 | 无授权请求 `/api/side-seat/*` → 403 `host-fence` ✅；截屏进程用完即回收 ✅ |


