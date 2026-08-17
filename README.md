# DSH Desktop

DeepSeek Harness 的 Linux 桌面客户端（Electron 外壳）。内嵌官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI，附带自动更新、稳定性自愈与视觉辅助插件。

## 界面预览

**主界面**：内嵌官方 Harness Web UI（工作区 / 新会话 / 极简模式），顶栏 ⚙ 进入设置面板。

<img src="assets/screenshot-main.png" width="720" alt="DSH Desktop 主界面：内嵌官方 Harness Web UI" />

**设置面板**：Harness 更新管理（通道/自动检查/自动安装）、视觉助手配置（`vision_describe` 接口 / 密钥 / 模型，保存即时生效）、引擎日志。

<img src="assets/screenshot-settings.png" width="360" alt="DSH Desktop 设置面板：更新、视觉助手、引擎日志" />

## 设计哲学

**不 fork、不魔改官方 dsh**——纯外壳封装：

- 应用启动时 spawn 官方 `dsh --profile web`（随机 loopback 端口），窗口内 iframe 嵌入官方 Web UI
- 官方 dsh 升级后自动跟进（内置更新管理器）
- 本仓库不包含任何官方 dsh 代码（官方 CLI 由用户自行安装，MIT 许可）

## 功能

- **官方 Web UI 内嵌**：原生 Harness 界面，会话/工具/工作流全支持
- **自动更新**：检查 `@deepseek-ai/dsh@next`（或 latest 通道）→ 一键安装 → 失败自动回滚
- **稳定性自愈**：Web 引擎意外退出自动重启（指数退避）；引擎日志面板
- **单实例锁**：重复启动聚焦已有窗口，不会起双引擎
- **设置面板**（顶栏 ⚙）：更新偏好、视觉助手配置、引擎日志、关于；ESC 关闭
- **视觉辅助插件**：让没有视觉能力的主模型通过 OpenAI 兼容视觉 API "看图"（见下）
- **无边框窗口**：自绘顶栏 + 窗口控制按钮

## 环境要求

- Linux（实测 Fedora + Wayland/niri；X11 应可用）
- Node.js ≥ 22、全局安装的 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（`npm install -g @deepseek-ai/dsh@next`）
- 凭据：`~/.dsh/.credentials.yaml`（官方 dsh 读取，本应用不接触密钥）

## 安装与运行

## 一键安装

```bash
git clone https://github.com/MoneShadow/DeepSeek-Harness-linux- && cd DeepSeek-Harness-linux-
./install.sh               # 全自动：环境检查 → dsh CLI → 依赖 → 视觉插件 → AppImage → 桌面入口 → 图标
```

分步模式：

```bash
./install.sh --no-build    # 跳过打包（仅依赖+插件）
./install.sh --no-plugin   # 跳过插件（仅依赖+构建）
npm start                  # 开发模式
npm run selfcheck          # 自检模式（截图+诊断，跑完自动退出）
npm run selfcheck-crash    # 自检 + 引擎崩溃自愈演练
npm test                   # 单元测试（28 用例）
npx electron-builder --linux AppImage   # 手动打包
```

> ⚠️ install.sh 首次安装官方 dsh 时执行全局 `npm install -g`，**安装期间请勿中断**
> （中断会损坏全局依赖树）。若误中断，执行 `npm install -g @deepseek-ai/dsh@next --force` 修复。

## 视觉助手插件（dsh-plugin-vision）

给主模型装上"眼睛"：注册 `vision_describe` 工具，通过 OpenAI 兼容视觉 API 描述图片（本地路径 / file:// / http(s) URL）。
插件独立维护：[dsh-plugin-vision](https://github.com/MoneShadow/dsh-plugin-vision)。

**粘贴图片自动转路径（桌面端内置，非插件功能）**：在官方 UI 输入框粘贴图片时，
本应用自动检测图片格式 → 拦截官方附件上传（文本模型不支持图片消息）→ 图片存盘
`~/.dsh/attachments/paste/` → 自动把 `[图片] /真实路径` 插入输入框 → 主模型用
`vision_describe` 查看。开关在设置面板「视觉助手」区块（`vision.autoPath`，默认开）。

**可用性分层**：
- 工具层：引擎侧注册，官方 Web UI、桌面端、headless 均可用
- 配置层：桌面端设置面板「视觉助手」区块（读写 `~/.dsh/settings.yaml` 的 `vision:` 段，**保存即时生效**，无需重启）；官方 UI 的插件配置区仅渲染内置卡片，第三方插件暂不显示

**安装插件**（需先退出 DSH Desktop / 停用该 profile 的引擎）：

```bash
./scripts/deploy-plugin.sh web    # 挂载到 web profile
# 验证：dsh --profile web --dump-config | grep -A8 'id: vision'
```

> ⚠️ 不要使用 `dsh plugin add file:` 安装本插件——它会向 profile 注入
> `@deepseek-ai/dsh-tools` 依赖副本，与全局树形成双实例，导致工具调用崩溃
> （`Cannot read properties of undefined (reading 'prepare')`）。
> `deploy-plugin.sh` 将插件实体放在 profile 的 `node_modules` 中；官方 dsh 更新不会覆盖该目录。

**配置**（设置面板或手动编辑 `~/.dsh/settings.yaml`）：

```yaml
vision:
  enabled: true
  baseURL: https://api.openai.com/v1   # 任意 OpenAI 兼容服务（通义千问/智谱/SiliconFlow…）
  apiKey: ""                            # 视觉模型密钥
  model: gpt-4o-mini                    # 如 qwen-vl-max / glm-4v
  timeoutMs: 60000
  cache: true                           # 按图片内容哈希缓存描述结果（命中免重复请求）
  cacheTtlSeconds: 3600                 # 缓存有效期（秒）
  cacheMaxEntries: 200                  # 缓存条目上限（LRU 淘汰）
```

关闭 `enabled` 时工具仍注册，但调用返回引导提示，主模型会据此提醒用户开启。

## 目录结构

```
main.js                     # 主进程：引擎生命周期/更新管理/自愈/窗口/IPC
preload.js                  # contextBridge 安全桥
lib/pure.js                 # 纯函数（版本比较/ANSI/URL 同源判定）
lib/vision-settings.js      # 视觉助手配置读写（settings.yaml 行级手术）
renderer/                   # 顶栏/设置面板/日志/iframe（原生 JS，无框架）
plugins/dsh-plugin-vision/  # 视觉辅助插件（独立 npm 包形态）
scripts/deploy-plugin.sh    # 插件部署（自动探测 dsh 安装位置）
scripts/sync-icons.sh       # 图标同步系统缓存（换图标后必跑）
scripts/panel-shot.js       # 设置面板截图/断言工具（UI 迭代验证）
tests/                      # node:test 单元测试
```

## 已知限制

- 仅打包 Linux AppImage（代码跨平台性待 mac/win 真机验证，见 TODO）
- 官方 UI 插件配置区仅渲染三张内置卡片，第三方插件需自带浏览器组件才能显示
- 应用自身（AppImage）无自更新机制（dsh 引擎的更新是自动的）

## 版权与致谢

- 应用图标为 DeepSeek 官方 logo（`assets/icon-source.jpg` / `assets/icon.png`），**版权归 DeepSeek 所有**，仅用于本应用标识
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）——官方 CLI 与 Web UI；官方项目处于开发者预览阶段，破坏性变更频繁，本应用通过自动更新机制跟进
- 依赖许可证清单见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

## 社区

- 插件相关问题欢迎在[官方 Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 交流
- 本仓库话题：`dsh-plugin`、`deepseek-harness`、`electron`、`linux`

## 卸载

```bash
./install.sh --uninstall
```

移除：视觉插件挂载（web profile）、AppImage、桌面入口、图标缓存。
**保留**：`~/.dsh`（会话数据/凭据/设置）、官方 dsh CLI、项目源码。
如需全部清除：`rm -rf ~/.dsh && npm uninstall -g @deepseek-ai/dsh`。

> 若应用正在运行，插件挂载不会被卸载（铁律），退出应用后重跑本命令即可。

## License

[MIT](./LICENSE)
