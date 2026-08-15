/**
 * dsh-plugin-vision — Cordis 插件入口
 *
 * 注册 `vision_describe` 工具到 host tools 注册表（global layer，所有 agent
 * 会话可见）。配置通过 **settings namespace `vision`** 暴露给官方设置 UI 的
 * 插件配置卡片（apiKey 为 secret 角色，write-only 不回显），改配置**即时生效**
 * （settings 服务 live 应用，无需重启引擎）。
 *
 * 开关语义（符合"视觉辅助"产品构想）：
 * - enabled=false 时工具**仍注册**，但调用返回明确提示——主模型据此提醒用户开启；
 * - 未配置 apiKey/model/baseURL 时同样返回配置引导，不抛异常。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { describeImage } from './describe.js';
import { collectImageRefs, renderAttachmentContext, readVisionSettingsFromFile } from './attachments.js';

export const name = 'vision';

export const inject = ['tools'];

/** 视觉辅助设置（同时用于工具行 config 校验与 settings namespace schema） */
export const VisionSettingsSchema = z.object({
  enabled: z.boolean().default(true).description('视觉辅助总开关：关闭后 vision_describe 会提示主模型引导用户开启'),
  autoPath: z.boolean().default(true).description('桌面端粘贴图片自动转为图片路径（替代官方附件，适配无视觉模型；由 DSH Desktop 注入实现）'),
  baseURL: z.string().default('https://api.openai.com/v1').description('OpenAI 兼容接口地址（如 OpenAI / 通义千问 / 智谱 / SiliconFlow 等，含 /v1）'),
  apiKey: z.string().role('secret').default('').description('视觉模型 API 密钥（write-only，不会回显）'),
  model: z.string().default('gpt-4o-mini').description('视觉模型名（如 gpt-4o-mini / qwen-vl-max / glm-4v）'),
  timeoutMs: z.number().default(60000).description('单次描述请求超时（毫秒）'),
});

/** 工具行运行时配置 schema（默认值层；用户配置走 settings namespace） */
export const Config = VisionSettingsSchema;

export function apply(ctx, config) {
  // 注册 settings namespace：官方设置 UI 的"插件配置"区据此渲染 vision 卡片；
  // 行 config 作为 base 默认层，用户写入的 settings section 覆盖之
  let settingsScope = null;
  ctx.inject(['settings'], (settingsCtx) => {
    settingsScope = settingsCtx.settings.register(
      settingsNamespace('vision'),
      VisionSettingsSchema,
      { base: config }
    );
  });

  // 动态上下文：每次模型请求渲染会话内的图片附件清单 + 可读路径。
  // 用户上传/粘贴图片（官方附件机制）后，主模型无需用户提供路径即可看到
  // "有哪些图片、路径在哪"，再调用 vision_describe 查看内容。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.context({
      name: 'vision:attachments',
      order: 95,
      text: (context) => {
        const session = context.agent?.session;
        if (!session) return '';
        try {
          const refs = collectImageRefs(session.deriveMessages());
          return renderAttachmentContext(refs);
        } catch {
          return '';
        }
      },
    });
  });

  ctx.tools.register(defineTool({
    name: 'vision_describe',
    description: 'Describe an image via the configured vision model (OpenAI-compatible API). ' +
      'Use this when you need to SEE an image — a local file path, file:// URL, or http(s) URL. ' +
      'Returns the model\'s textual description of the image contents.',
    parameters: {
      image: {
        type: 'string',
        required: true,
        description: 'Image source: an absolute or relative local path (e.g. /home/mone/a.png), a file:// URL, or an http(s):// URL. Local images are sent as base64 data URLs.',
      },
      prompt: {
        type: 'string',
        description: 'Optional custom question about the image (default: detailed description of subject, layout, colors, text, style).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => {
      // 每次调用取最新设置（settings 服务 live 应用，改配置无需重启）
      let cfg = settingsScope ? settingsScope.get() : config;
      // 兜底：settings 服务在部分启动时序下可能未发布文件内容（apiKey 空），
      // 直接从 settings.yaml 读取补齐
      if (!cfg.apiKey) {
        const fileCfg = readVisionSettingsFromFile();
        if (fileCfg && fileCfg.apiKey) cfg = { ...cfg, ...fileCfg };
      }
      if (!cfg.enabled) {
        return '视觉辅助已关闭：主模型没有视觉能力，如需查看图片请在 DSH Desktop 的 设置 → 插件配置 中开启 dsh-plugin-vision 的 enabled 开关（或直接告诉用户开启）。';
      }
      return describeImage(cfg, {
        image: args.image,
        prompt: args.prompt,
      });
    },
  }));
}
