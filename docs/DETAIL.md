# 旁座 SideSeat · 实现细节与现场核实清单

本文给接手的人看：哪些宿主事实已经核对过、哪些必须在你的机器上现场复核，以及施工指令书里每一条验收项落在代码的哪个位置。

## 0. 证据基线

开发时没有接触到你本机的 DSH 0.2.2-rc.5。宿主接口按下面三类来源交叉核对，**凡是只靠单一来源的，都列进了第 1 节的 M0 清单**：

1. 施工指令书 5.1 的事实表（本机实测，其中有「待核实」项）。
2. 官方仓库文档：插件配置（`.volatile()` 与 `.get()`）、工具编写参考（`output.schema` / `render` / `exec.signal`）、扩展手册（`agent.followup()` / `agent.inject()`、`session/event`）、API Gateway（独立安装包不会自动出现 `ctx.remote.<ns>`）、WebServer（具名的精确 / 前缀路由，最长匹配）、Storage（`defineDomain` / `domainTable` / `ctx.storageDomain.open`）。
3. 已发布插件的实际写法：dsh-video-vision（插件直接注册普通工具对象、`ctx.attachments.saveImage`、`{ text: string }` 契约）、dsh-videostory（`llm.stream` 的消息形态、`resolveModelInfo().inputModalities`）、dsh-plugin-template（Client 半边的 `__ModuleLoader__` 格式、`ctx.slots.inject(...register...)`、`ctx.configForms`）、dsh-power-button（`sidebar.footer.action`、`ctx.get('…')` 读可选服务、Desktop 的 Host 是 Electron 外壳的**子进程**）。

## 1. M0 现场核实清单（开工第一件事）

每一项都给出怎么查、代码在哪，以及查出来不对时怎么改。查询都用 `cordis_inspect_query`。

| # | 待核实 | 怎么查 | 代码位置 | 不一致时 |
|---|---|---|---|---|
| 1 | `ctx.llm.stream` 的 chunk 形态（`text-delta`、`finish.reason.kind`）和 `resolveModelInfo` | 查 llm 服务签名 | `src/vision.js` `ask()` / `checkModel()` | 只改这两个函数 |
| 2 | `ctx.attachments.saveImage({ data, mediaType, name })` 返回的引用能直接放进 `{ type:'image', attachment }` | 查 attachments 服务 | `src/vision.js` `imageBlock()` | 已经带了 `admitPromptContent` 兜底 |
| 3 | `imageRequestTarget(provider, model, ref)` 的真实签名 | 查 llm 服务 | `src/vision.js` `targetWidth()` | 不存在时按 1280 / 512 处理，不影响功能 |
| 4 | `ctx.agents.create({ sessionId, meta:{ agentPreset }, setup })` 的返回值里怎么拿 `session` 和 `agent` | 查 agents 服务 | `src/session.js` `normalize()` / `open()` | 改 `normalize()` |
| 5 | `setup(agentCtx)` 里注册人格段的 `systemPrompt.section` 签名 | 查 systemPrompt 服务 | `src/session.js` `registerPersona()`（会依次尝试三种写法） | 留下正确的那种写法；诊断里的 `persona` 字段会显示 `section` / `failed` / `unavailable` |
| 6 | **路径一**：`session.append('assistant/message', data, { surfaceOp:'append' })` 中 `data`（特别是 `stream` 字段）的构造，以及 Web 端能不能渲染成一条助手消息 | 先在最小例子里 append 一条，再看界面 | `src/speak.js` `assistantData()` | 渲染不出来就把 `speakPath` 锁成 `followup` 或 `overlay`（设置项或环境变量 `DSH_SIDE_SEAT_SPEAK_PATH`）。**这是硬性前置：M0 阶段就要定下来** |
| 7 | `session/event` 里用户消息的事件类型名 | 查 session 事件 | `src/session.js` `watch()` | 改 `isUser` 的判断 |
| 8 | WebServer 精确路由的注册签名 `ctx.webServer.register({ name, path, handler })`，以及 Connection 的 `requestRejection(req)` | 查 webServer / connection 服务 | `src/bridge.js`（会依次尝试三种写法；诊断里的 `bridge.mode` 应为 `webserver`） | 只改 `attempts()` |
| 9 | **Desktop（`file://` + IPC fetch）里，浏览器半边的 `fetch('/api/side-seat/…')` 能不能到达 Host** | 在 Desktop 里打开面板，看有没有出现「连不上旁座的宿主半边」 | `client.js` `api()`（失败时会退到 `ctx.get('connection').fetch`） | 如果都到不了，就需要按官方 API Gateway 手写 Remote 描述符；只需要换 `api()` 这一个函数 |
| 10 | Client 槽位 `settings.section` 的注册参数（目前只传了 `id` / `order` / `label`） | `cordis_inspect` `what:"client"` 查槽位声明 | `client.js` 末尾的 `register(...)` | 补上缺的参数 |
| 11 | `ctx.configForms.get('side-seat')` 能拿到 `ready` 快照（也就是 `.volatile()` 字段确实派生出了命名空间） | 打开设置页，看有没有出现「宿主没有把 side-seat 设置命名空间暴露给浏览器」 | `client.js` `useConfigForm()` | 没有暴露时自动改用 `settings.json` 兜底；不影响使用，但设置不会跟着 profile 走 |
| 12 | 后端 A：Host 进程里能不能拿到 `require('electron').desktopCapturer` | 看诊断里截屏后端的尝试记录 | `src/capture/electron.js` | 公开资料显示 Desktop 的 Host 是 Electron 外壳的子进程，**预计 A 不可用，会落到后端 C（PowerShell）**，这是预期行为 |
| 13 | 浏览器端 `getDisplayMedia` 能不能拿到 audio track（Desktop 需要外壳允许桌面捕获） | 点「开始看屏幕」，看状态条写的是「能听到声音」还是「收不到声音」 | `client.js` `startAudio()` | 拿不到时会自动尝试 dshow 立体声混音；两者都不行，状态条会写明听不见 |
| 14 | 凭据服务：Client 端 `credentials.set(ref, value)` 和 Host 端 `credentials.resolve(ref)` 的形态 | 查 credentials 服务 | `src/audio/asr.js` `createCredentials()`、`client.js` `saveKey()` | 都不可用时，可以直接编辑 `.credentials.yaml`，或者设环境变量 `SIDE_SEAT_ASR_API_KEY` |
| 15 | DSH 内置 STT 服务的名字和 `transcribe()` 签名 | 查服务表 | `src/audio/asr.js` `builtinService()` | 没有内置 STT 时，「DSH 内置」选项会如实显示不可用 |
| 16 | 工具 `output.schema: { type: 'json' }` 是否被 0.2.2-rc.5 接受 | 装好后让模型调用一次 `side_seat_profile read` | `src/tools.js` `output` | 换成显式的对象 schema |

M0 的完成标志是：截屏三个后端里至少两个能跑通、音频采集和至少一种听写引擎能跑通、主动发言路径已经锁定，并把结论记进本文末尾的记录表。

## 2. 架构

```
Client（client.js）                               Host（index.js + src/）
┌──────────────────────────────┐   HTTP 精确路由   ┌─────────────────────────────────────────┐
│ sidebar.footer.action 入口+点 │ ───────────────▶ │ bridge.js  /api/side-seat/<endpoint>     │
│ shell.overlay  面板 / 兜底卡片 │ ◀─── 1s 轮询 ─── │   ├ observer.js  A 轴循环                 │
│ composer.dock  状态条          │                  │   │   capture/ ─▶ diff.js ─▶ judge.js      │
│ settings.section 设置页        │                  │   │   ─▶ speak.js（三条路径）               │
│ getDisplayMedia ─▶ L0 摘要/片段 │ ── audio-* ───▶ │   ├ audio/hub.js  L0 / 听写队列 / 回声     │
│ speechSynthesis 朗读（可打断） │                  │   ├ session.js  旁座自己的会话 + 人格段    │
└──────────────────────────────┘                  │   └ memory.js  四张表 + moments           │
                                                  │ tools.js  side_seat_look/caption/review/profile │
                                                  │   └ video/  ffmpeg 解码、镜头、OCR、caption、review │
                                                  └─────────────────────────────────────────┘
```

**时间轴统一**：画面帧和台词 cue 都用 epoch 毫秒做地址。重判断拿到的台词带相对时间（`[-12s] …`），B 轴的产物都换算成文件内的 `[mm:ss]`。

**观察循环**（`src/observer.js`）：

```
每 1 秒  截一帧（内存，最多 10 帧）-> dHash + 像素差（32x18 灰度栅格）
  到点：(距上次轻判断 >= 20 秒 且 有变化或有人声) 或 累计 dirty >= 3
    预闸门：免打扰 / 被嫌烦静默 / 预算 <= 0 / 10 分钟视觉调用 >= 20  -> SILENT（不花一分钱）
    轻判断（512 宽缩略图）-> noteworthy? -> 硬闸门（低谷 / 背景音 / 别抢话 / 网页文档 / 游戏不足 30 秒 / 看不清）
    显著度 = 0.28 转折 + 0.22 口味 + 0.15 新鲜 + 0.10 声音 + 0.05 久未开口
      >= 0.62 -> 重判断（近原尺寸 + 记忆 + 最近 5 句 + 台词）-> 再加 0.20 观点呼应（冲突一票否决）
      >= 0.45 -> WAIT 60 秒
      其他    -> SILENT
    最终裁决：模型要说 SPEAK、显著度 >= 0.62、置信度 >= 0.5、措辞合规、不和最近说过的话重复；说之前再过一次预闸门
  每一次 SILENT 都写 { t, reason, stage } 到 moments
```

## 3. 验收项落点（第十章，17 项）

| # | 验收项 | 落在哪里 | 自检 / 怎么测 |
|---|---|---|---|
| 1 | 侧边栏入口 | `client.js` `SidebarAction`（`sidebar.footer.action`，id `side-seat.entry`）；点击后 `ensureSession()` | 自检会检查槽位；实机看底部 |
| 2 | 设置页 | `client.js` `SettingsPage`（`settings.section`），写入走 `configForms`，兜底写 `settings.json` | 改完重启，看值还在不在 |
| 3 | 2 秒内拿到首帧，显示后端 | `src/capture/index.js` `probe()`（真截一帧才算可用）；状态里有后端名 | 冷启动的 PowerShell 首帧大约 1–2 秒 |
| 4 | 不装 ffmpeg 也能跑 A 轴 | 后端 C 只用 Windows 自带的 PowerShell + System.Drawing | 卸掉 ffmpeg 再跑一遍 |
| 5 | 10 分钟视觉调用不超过 20 次 | `judge.js` `VISION_CAP_PER_10MIN`，硬上限 | 状态里的 `vision.callsLast10Min` |
| 6 | 每小时说话不超过预算 | `judge.js` `budgetRemaining()` + 说之前的二次预闸门 | 自检里有「默认预算下前几分钟零调用」 |
| 7 | 主动发言可见 | `src/speak.js` 三条路径 | 见 M0 第 6 项 |
| 8 | 朗读可打断 | `client.js` `onState()`：`userSpokeAt` 一变就 `speechSynthesis.cancel()`；朗读期间每 400ms 轮询一次 | 朗读时发一条消息 |
| 9 | 观察期间始终可见 | 指示点 + 状态条；点停止时先改本地状态再通知宿主 | 自检里有「停止后点和状态条都消失」 |
| 10 | 降级时不撒谎 | 截屏连续失败 3 次就 `fail()`；模型不能看图就拒绝开始；视觉调用失败时这一轮不说话并写进 notes | 拔网线、换一个纯文本模型试试 |
| 11 | B 轴四项 | `src/tools.js` + `src/video/*` | 准备一段测试视频 |
| 12 | 记忆跨重启保留 | `src/memory.js`（storage domain，或 JSON 原子写） | 重启后调用 `side_seat_profile read` |
| 13 | 零冲突 | 见 README「零冲突」，和 dsh-video-vision 同时安装 | 工具列表里不应该有重名 |
| 14 | 卸载干净 | `index.js` 的 effect：停止观察、回收子进程（`taskkill /T /F`）、释放捕获 | 停用插件后看任务管理器里有没有残留的 powershell |
| 15 | 听写引擎可配 | 设置页「听写引擎（高级）」+「试一下」（现场合成中文样例音频） | 依次试三种引擎 |
| 16 | 没有引擎时不撒谎 | `audio/hub.js` `cueLines()` 在引擎为「无」时返回空；状态条写「听不见台词」；重判断的提示词里写明「你听不见台词，不许编造」 | 自检里有 |
| 17 | 回声不会被当成内容 | 浏览器端朗读期间不送片段；Host 端 `EchoFilter`（相似度 > 0.8 丢弃，带编辑距离） | 自检里有 |

另外必须做的一件事：**找一个真人开着它看 30 分钟视频、打 20 分钟游戏**，记下他什么时候笑了、什么时候嫌烦。设置页「状态」里的 moments（沉默记录）和每句话的反馈，就是算「开口接受率 / 打扰率 / 沉默正确率」的数据来源。

## 4. 已知设计取舍

- **默认预算下，前 100 分钟它不会开口。** 这是 `floor(时长 × 0.6)` 公式本身的结果，代码完全按指令书实现。实机试用 30 分钟的话，「正常」档不会说话。建议试用时把频率调成「话多」（50 分钟出第一句），或者在 M3 阶段讨论要不要给一个首句额度。这是产品决策，代码里没有私自改。
- **Host↔Client 通路走 WebServer 精确路由，没有用 Typert Remote。** 原因是官方文档写明，独立安装包里的 `@Remote` 不会自动出现在 `ctx.remote` 上。代价是 Desktop 下需要核实 M0 第 9 项。
- **cordis.patch.yml 只有 Host 一行。** 指令书写的是「Host 插件行 + client 插件行」，但官方模板和已发布插件的做法都是：Client 半边由 `package.json` 的 `dsh.client` 声明，按包名发现，不在 patch 里另写一行。如果你的 0.2.2-rc.5 确实需要单独的 client 行，补一行就行，`id` 用 `side-seat-client`。
- **用户正在输入时不说话，完全靠画面判断**（轻判断里的 `userBusy`，加上连续几帧都是轻微变化时判定为高频滚动），不监听键盘。
- **Web Speech 朗读的打断依赖轮询**，延迟不超过约 400ms。

## 5. 文件地图

```
dsh-side-seat/
├── package.json          dsh.bundle.patch -> cordis.patch.yml；dsh.client 声明 Client 半边
├── cordis.patch.yml      Host 插件行（id side-seat = 设置命名空间）
├── index.js              Host 入口：组装、路由、诊断、卸载
├── client.js             Client 入口（__ModuleLoader__ 包）：四个槽位、声音采集、朗读
├── src/
│   ├── capture/          index.js 探测与统一 grab()；electron.js / ffmpeg.js / pwsh.js 三个后端
│   ├── audio/            events.js L0；capture.js dshow 兜底与切片；asr.js 引擎与凭据；echo.js 回声；hub.js 中枢
│   ├── video/            index.js 解码；shots.js 描述；ocr.js；caption.js；review.js
│   ├── diff.js           dHash / 像素差 / dirty / 新鲜度 / 滚动判断
│   ├── judge.js          轻判断 / 重判断 / 闸门 / 显著度 / 预算（纯函数为主）
│   ├── observer.js       A 轴循环
│   ├── speak.js          三条发言路径
│   ├── session.js        旁座自己的会话 + 人格段
│   ├── vision.js         截图 -> 附件 -> llm.stream
│   ├── memory.js         四张表 + moments + schema 校验
│   ├── persona.js        「它是谁」-> 人格段；措辞约束
│   ├── tools.js          四个 side_seat_* 工具
│   ├── bridge.js         HTTP 精确路由 + 信任围栏
│   ├── config.js         Config（schemastery，.volatile()）+ 兜底设置
│   ├── compat.js         平台 / 版本 / 可选服务
│   ├── media.js          子进程、ffmpeg 定位、进程树回收
│   └── util.js
├── locale/zh.json en.json
├── docs/DETAIL.md preview.svg
├── test/selfcheck.mjs
├── icon.svg
└── README.md
```

## 6. M0 结论记录表（现场填写）

| 项 | 结论 | 日期 / 记录人 |
|---|---|---|
| 截屏后端 A / B / C |  |  |
| 浏览器端系统声音 / dshow |  |  |
| 听写引擎（选了哪一种） |  |  |
| 主动发言路径（锁定成哪一条） |  |  |
| Desktop 通路 |  |  |
| settings.section 参数 |  |  |
