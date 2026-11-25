# 发布前检查清单

每次发版照着走一遍。任何一项没过就不要打 tag。

## 1. 代码与测试

- [ ] `node test/selfcheck.mjs` 全绿
- [ ] 契约模拟 / 决策沙箱全绿（如改动涉及契约或阈值）
- [ ] 所有 `.js` 通过 `node --check`
- [ ] `overlay/overlay.ps1` 能被 PowerShell 解析（且保留 **UTF-8 BOM**，PS 5.1 需要）
- [ ] `package.json` 版本号已递增

## 2. 敏感信息

- [ ] 全仓扫描无 `token`、`sk-`、`Bearer`、Cookie、`credentials.json`
- [ ] 无个人绝对路径（`C:\Users\<你的用户名>`）
- [ ] 提交历史里也没有（改过历史要换凭据，删 commit 不算）

## 3. 打包

- [ ] `pnpm pack` 成功，产物名与 `package.json` 的 `name` + `version` 一致
- [ ] 包内包含：`index.js`、`client.js`、`src/`、`overlay/`、`locale/`、`README.md`、`LICENSE`、`SECURITY.md`
- [ ] 包内**不**包含：`node_modules/`、`*.log`、`plugins-data/`、`_scratch/`、`sim/`
- [ ] 生成 `SHA256SUMS.txt`

## 4. 仓库设置

- [ ] 仓库 About 里加了 `dsh-plugin` topic（社区发现靠它，不是官方认证）
- [ ] `package.json` 的 `repository` / `bugs` / `homepage` 指向真实仓库
- [ ] README 顶部有「非官方（Unofficial）」声明
- [ ] README 里有可复制的安装命令，且包名与实际产物一致
- [ ] README 里的兼容范围（`dshCompat`）与实测版本一致

## 5. Release

- [ ] 附上 `.tgz` 与 `SHA256SUMS.txt`
- [ ] Release notes 写清：新增 / 修复 / 破坏性变更 / 已知限制
- [ ] 不在 Release 里放源码 zip 冒充安装包
