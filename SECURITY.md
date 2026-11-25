# 安全说明

## 这个插件在你机器上做了什么

旁座不是"沙箱里的小程序"。**DSH 插件以宿主进程的权限运行，DSH 本身不提供沙箱隔离**（见 DSH 仓库的 SAFETY.md）。装旁座 = 允许它在你的用户权限下做下面这些事。你在安装前应当知道它们：

| 行为 | 何时发生 | 说明 |
|---|---|---|
| 截屏主屏 | 你点了「开始看屏幕」，或你明确调用 `side_seat_look` | 走常驻的 Windows PowerShell（WPF `CopyFromScreen`），截图只在内存里用，**不落盘** |
| 启动子进程 | 看屏幕 / 看视频时 | 常驻 `powershell.exe`；ffmpeg 相关操作会起 `ffmpeg.exe`。插件卸载时会 `taskkill /T /F` 收掉整棵进程树 |
| 读本地文件 | 你让它看某个视频 / 图片时 | 只读你指定的那个路径，不做目录扫描 |
| 写文件 | 一直 | 只写 `%DSH_HOME%/plugins-data/side-seat/`（记忆、日志、弹窗数据）和你明确指定的导出路径 |
| 联网 | 看屏幕 / 看视频时 | 截图或抽帧会发给你配置的视觉模型服务（DSH 里已配置的 provider）。启用云端听写时，会额外发送**检测到人声的片段**，且必须先由你勾选同意 |
| 开窗口 | 你点「桌面弹窗」时 | 一个 WPF 置顶小窗，已设置 `WDA_EXCLUDEFROMCAPTURE`，**不出现在任何截图中**（包括旁座自己的截图） |

## 不会做的事

- 不会在后台偷偷截屏：截屏只在「开始看屏幕」或明确的工具调用期间发生
- 不会把截图、音频长期保存到磁盘
- 不会读取你的 Cookie、token、浏览器数据、无关文件
- 不会修改系统设置、注册表、PATH
- 不会自动下载可执行文件：**ffmpeg 只在你点击「安装 ffmpeg」时下载**，来源见下

## ffmpeg 下载来源

设置页的「安装 ffmpeg」会依次尝试：

1. `https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0/ffmpeg-win32-x64.gz`（国内镜像，单文件，约 29MB）
2. `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip`（LGPL 构建，约 179MB）
3. `https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`（约 119MB）

下载后只做解压与复制，落到 `%DSH_HOME%/plugins-data/side-seat/bin/`。不写系统 PATH，不改注册表。

## 数据存在哪

- 记忆（口味 / 账本 / 关系 / 共同经历）：`%DSH_HOME%/plugins-data/side-seat/memory.json`
- 日志：同目录下的 `*.log`
- 桌面弹窗的显示内容与收件箱：同目录 `overlay/`

设置页有「清除全部记忆」，会真的删除并报告删了几条。

## 已知风险

- **截屏会包含屏幕上的一切**（密码框、私聊、其他应用）。旁座只能保证"你不让它看时它不看"，不能保证"它看到了不会发给你配置的模型服务"。敏感场景请在开始陪看前先关掉。
- **桌面弹窗对其他程序透明**：`WDA_EXCLUDEFROMCAPTURE` 让它对截图不可见，但录屏软件、OBS 的窗口捕获、以及你手机拍屏幕依然能看到它。
- **子进程继承你的权限**：常驻的 PowerShell 和 ffmpeg 以你的用户身份运行。

## 报告安全问题

请**不要**开公开 Issue。用 GitHub 的私密漏洞报告：

> 仓库页 → Security → Report a vulnerability

或直接邮件联系维护者。我们会在 **7 天内**确认收到，并在修复发布后于 Release 说明里致谢（除非你要求匿名）。
