# dsh-plugin-vision（DSH Desktop 出厂内置快照）

> 本目录为 DSH Desktop 出厂内置的插件快照。独立维护与开源地址：
> **dsh-plugin-vision**（独立仓库：https://github.com/MoneShadow/dsh-plugin-vision ，安装/配置/故障排查见其 README）。

# dsh-plugin-vision

给 DeepSeek Harness 装上"眼睛"的视觉辅助插件：注册 `vision_describe` 工具，
让没有视觉能力的主模型通过任意 OpenAI 兼容视觉 API 描述图片。

## 功能

- **工具**：`vision_describe(image, prompt?)` —— 本地路径 / file:// / http(s) URL 均可，
  本地图片以 base64 data URL 发送，返回视觉模型的文本描述
- **答案缓存**：按"图片内容哈希 + 接口 + 模型 + 提问"缓存描述结果（TTL + LRU 上限），
  同一张图重复查看直接命中缓存，不再消耗视觉 API 调用；对主模型透明，错误不缓存
- **开关语义**：`enabled=false` 时工具仍注册但返回明确提示，主模型会据此提醒用户开启
- **配置热更新**：配置存 `~/.dsh/settings.yaml` 的 `vision:` 段，引擎监视文件变化，
  保存即时生效（无需重启引擎）
- **密钥安全**：apiKey 以 secret 角色存储（官方设置 UI 中 write-only 不回显）

## 与 DSH Desktop 的配合（重要：粘贴转路径不是本插件的功能）

**"粘贴图片自动转路径"由 DSH Desktop（桌面端）内置实现，不是本插件的一部分**——
它是 UI 层功能：

```
用户粘贴图片 → DSH Desktop 向官方 UI iframe 注入的补丁（监听 paste、检测图片格式）
→ 拦截官方附件流程 → 图片存盘 → 自动把 "[图片] /真实路径" 插入输入框
→ 主模型看到路径 → 调用本插件的 vision_describe 查看
```

- **为什么不在插件里**：粘贴事件监听必须在浏览器 UI 层，而插件运行在引擎
  （dsh 进程）侧，无法感知浏览器粘贴操作
- **配置共享**：该功能的开关 `autoPath` 存在同一段 `settings.yaml` 的 `vision:` 段，
  由 DSH Desktop 读取并控制注入行为；本插件仅同步声明该字段，不实现功能
- 只安装本插件（不使用 DSH Desktop）时：没有粘贴自动转路径，需要手动把图片
  路径/URL 传给 `vision_describe`

## 安装（DSH Desktop 内置）

本快照是 DSH Desktop 的插件源码目录，由 `scripts/deploy-plugin.sh` 部署
（探测 dsh 安装位置 → 插件实体复制到全局依赖树 → profile 建立软链 →
清理依赖副本 → 注册 manifest bundles）：

```bash
cd ~/dsh-desktop
./scripts/deploy-plugin.sh web              # 部署到 web profile
./scripts/deploy-plugin.sh vision-dev       # 部署到其他 profile
```

> ⚠️ **不要使用 `dsh plugin add file:...` 安装本插件**——它会向 profile 注入
> `@deepseek-ai/dsh-tools` 依赖副本，与全局依赖树形成双实例，导致**任何工具调用
> 崩溃**（`Cannot read properties of undefined (reading 'prepare')`）。
> 根因与修复详见独立仓库 README 的"故障排查"。

## 配置（官方 UI 设置 → 插件配置 → vision，或 DSH Desktop 设置面板）

| 字段 | 说明 | 默认 |
|---|---|---|
| enabled | 总开关 | true |
| autoPath | 粘贴图片自动转路径（DSH Desktop 功能） | true |
| baseURL | OpenAI 兼容接口地址（含 /v1） | `https://api.openai.com/v1` |
| apiKey | 视觉模型 API 密钥（secret，不回显） | 空 |
| model | 视觉模型名 | `gpt-4o-mini` |
| timeoutMs | 单次请求超时 | 60000 |
| cache | 按图片内容哈希缓存描述结果 | true |
| cacheTtlSeconds | 缓存有效期（秒） | 3600 |
| cacheMaxEntries | 缓存条目上限（LRU 淘汰） | 200 |

任意 OpenAI 兼容视觉服务均可：OpenAI、通义千问 qwen-vl、智谱 glm-4v、
SiliconFlow 等。注意 DeepSeek 官方 API 目前（0.1.0-rc.6 时代）无视觉模型，
不可用默认 key。

## 测试

```bash
node --test tests/describe.test.js tests/attachments.test.js tests/cache.test.js
# 43 用例：图片源转换/请求构造/错误/超时/配置引导/缓存命中与淘汰
```

## 卸载

卸载请使用独立仓库的 `install.sh uninstall`（同步移除 manifest 的 bundles 声明、
profile 软链与全局树实体；引擎运行时拒绝操作，退出应用后重跑）：

```bash
git clone https://github.com/MoneShadow/dsh-plugin-vision && cd dsh-plugin-vision
./install.sh uninstall web
```
