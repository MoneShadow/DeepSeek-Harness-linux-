/**
 * dsh-plugin-vision — Cordis 插件入口
 *
 * 注册 `vision_describe` 工具到 host tools 注册表（global layer，所有 agent
 * 会话可见）。配置经官方设置 UI 的插件配置卡片修改（apiKey 为 secret 角色）。
 *
 * 开关语义（符合"视觉辅助"产品构想）：
 * - enabled=false 时工具**仍注册**，但调用返回明确提示——主模型据此提醒用户开启；
 * - 未配置 apiKey/model/baseURL 时同样返回配置引导，不抛异常。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { describeImage } from './describe.js';

export const name = 'vision';

export const inject = ['tools'];

/** 运行时配置 schema（官方设置 UI 据此渲染插件配置卡片） */
export const Config = z.object({
  enabled: z.boolean().default(true).description('视觉辅助总开关：关闭后 vision_describe 会提示主模型引导用户开启'),
  baseURL: z.string().default('https://api.openai.com/v1').description('OpenAI 兼容接口地址（如 OpenAI / 通义千问 / 智谱 / SiliconFlow 等，含 /v1）'),
  apiKey: z.string().role('secret').default('').description('视觉模型 API 密钥（write-only，不会回显）'),
  model: z.string().default('gpt-4o-mini').description('视觉模型名（如 gpt-4o-mini / qwen-vl-max / glm-4v）'),
  timeoutMs: z.number().default(60000).description('单次描述请求超时（毫秒）'),
});

export function apply(ctx, config) {
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
      if (!config.enabled) {
        return '视觉辅助已关闭：主模型没有视觉能力，如需查看图片请在 DSH Desktop 的 设置 → 插件配置 中开启 dsh-plugin-vision 的 enabled 开关（或直接告诉用户开启）。';
      }
      return describeImage(config, {
        image: args.image,
        prompt: args.prompt,
      });
    },
  }));
}
