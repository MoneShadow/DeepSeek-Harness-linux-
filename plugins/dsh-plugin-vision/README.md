# dsh-plugin-vision（DSH Desktop 出厂内置快照）

> 本目录为 DSH Desktop 出厂内置的插件快照。独立维护与开源地址：
> **dsh-plugin-vision**（独立仓库，安装/配置/故障排查见其 README）。
>
# dsh-plugin-vision

给 DeepSeek Harness 装上"眼睛"的视觉辅助插件：注册 `vision_describe` 工具，
让没有视觉能力的主模型通过一个 OpenAI 兼容的视觉模型 API 描述图片内容。

## 设计

- **挂载方式**：标准 dsh bundle 插件（`dsh.bundle.patch` 声明），工具行插入
  host plane，所有 agent 会话可见（tools 注册表 global layer）。
- **工具**：`vision_describe(image, prompt?)` —— 本地路径 / file:// / http(s) URL
  均可；本地图片以 base64 data URL 发送。
- **配置入口**：官方 UI 的 设置 → 插件配置 卡片（schema 自动渲染；
  `apiKey` 为 secret 角色，write-only 不回显）。改配置后重启引擎生效。
- **开关语义**：`enabled=false` 时工具仍注册但返回明确提示，主模型会据此
  提醒用户去开启——符合"主模型需要看图时引导用户开开关"的产品构想。

## 安装

```bash
cd ~/dsh-desktop/plugins/dsh-plugin-vision
PATH=$PATH:$HOME/.local/bin dsh plugin --profile web add file:$(pwd)
# 验证已加载：
dsh --profile web --dump-config | grep -A8 'id: vision'
# 重启引擎（重启 DSH Desktop 应用）后生效
```

## 配置（官方 UI 设置 → 插件配置 → vision）

| 字段 | 说明 | 默认 |
|---|---|---|
| enabled | 总开关 | true |
| baseURL | OpenAI 兼容接口地址（含 /v1） | `https://api.openai.com/v1` |
| apiKey | 视觉模型 API 密钥（secret，不回显） | 空 |
| model | 视觉模型名 | `gpt-4o-mini` |
| timeoutMs | 单次请求超时 | 60000 |

任意 OpenAI 兼容视觉服务均可：OpenAI、通义千问 qwen-vl、智谱 glm-4v、
SiliconFlow 等。注意 DeepSeek 官方 API 目前（0.1.0-rc.6 时代）无视觉模型，
不可用默认 key。

## 测试

```bash
node --test tests/describe.test.js   # 11 用例：图片源转换/请求构造/错误/超时
```

## 卸载

```bash
PATH=$PATH:$HOME/.local/bin dsh plugin --profile web remove dsh-plugin-vision
```
