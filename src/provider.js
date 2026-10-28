/**
 * src/provider.js —— 模型调用封装（可替换的 provider）
 *
 * 配置优先级：网页设置面板（data/settings.json）> .env 环境变量。
 * 这样组员可以在网页上自己填 API Key / 换厂商，改完立即生效（不用重启）。
 *
 * 为什么自己写一个薄 provider，而不用 ai-form-response-extractor 内置的 openai()：
 *   内置 provider 只读 OPENAI_API_KEY，不支持自定义 Base URL（写死 new OpenAI({apiKey})）。
 *   我们需要指向 OpenCode Go 等兼容端点，所以按它的 LLMProvider 接口自己实现。
 *
 * 换厂商 = 在设置面板选预设或填 Base URL + Key + 模型名，不改任何代码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

// 厂商预设：识别问卷必须用「多模态（能看图）」的模型，预设里给了各家的建议型号
const PRESETS = {
  'opencode-go': { label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'mimo-v2.6-flash', modelNote: '实测最便宜（约 $0.0002/份），注意模型 ID 全小写' },
  'openai': { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', modelNote: 'gpt-4o 及以上支持视觉' },
  'deepseek': { label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: '', modelNote: '需填支持图像输入的模型名' },
  'custom': { label: '自定义（任何 OpenAI 兼容端点）', baseUrl: '', model: '', modelNote: '' }
};

// 读网页设置面板保存的配置；文件不存在/损坏时返回空对象（回退到 .env）
function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (e) {
    console.warn('settings.json 读取失败，回退到 .env 配置：' + e.message);
  }
  return {};
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8');
}

// 合成生效配置：设置面板 > .env
function effectiveConfig() {
  const s = readSettings();
  return {
    apiKey: (s.apiKey || '').trim() || process.env.OPENAI_API_KEY || '',
    baseUrl: (s.baseUrl || '').trim() || process.env.OPENAI_BASE_URL || 'https://opencode.ai/zen/go/v1',
    model: (s.model || '').trim() || process.env.LLM_MODEL || 'mimo-v2.6-flash',
    presets: PRESETS
  };
}

// OpenCode Go 端点要求：x-opencode-session（稳定会话 ID）+ 可识别的 User-Agent，
// 否则返回 400 "Request is missing x-opencode-session"（见 opencode.ai/docs/go）。
// 对其他厂商端点这是无害的多余头。
const SESSION_ID = 'paper-survey-digitizer-' + crypto.randomUUID();

function createOpenAICompatibleProvider() {
  const cfg = effectiveConfig();
  if (!cfg.apiKey) {
    throw new Error('还没有配置 API Key：点页面右上角「⚙ 设置」填写，或在 .env 里配置');
  }
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
    defaultHeaders: {
      'x-opencode-session': SESSION_ID,
      'User-Agent': 'paper-survey-digitizer/0.1'
    },
    // 超时保护：上游抖动/挂死连接时最多等 3 分钟就失败，
    // 交给识别库重试（否则 SDK 默认超时 10 分钟，一次调用能挂半小时）
    timeout: 180000,
    maxRetries: 1
  });
  return {
    name: 'openai-compatible',
    model: cfg.model,
    async extractFromImage({ image, prompt, systemPrompt }) {
      // image 可能是单张 Buffer，也可能是多页问卷的 Buffer 数组：
      // 多页时每页一个 image_url 块放进同一次请求，模型一次看完整份问卷
      //（不要按页拆多次请求再合并——识别库文档明确警告这会丢数据）
      const buffers = Array.isArray(image) ? image : [image];
      const dataUrl = (buf) => `data:image/${guessExt(buf)};base64,${buf.toString('base64')}`;
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...buffers.map(buf => ({ type: 'image_url', image_url: { url: dataUrl(buf) } }))
        ]
      });
      // response_format: json_object 让模型只回 JSON（识别库靠这个解析结果）。
      // reasoning_effort: "none" 关闭思考模式——问卷识别是抄录不是推理，
      // 实测 mimo 9.9s→2.1s、推理 token 213→0，结果不受影响。
      // 有些厂商端点不认这个参数（如 gpt-4o），报错时自动去掉参数重试一次。
      const body = {
        model: cfg.model,
        messages,
        response_format: { type: 'json_object' }
      };
      if (process.env.LLM_REASONING !== 'on') {
        body.reasoning_effort = 'none';
      }
      let resp;
      try {
        resp = await client.chat.completions.create(body);
      } catch (e) {
        if (body.reasoning_effort && /reasoning|effort|unrecognized|unknown/i.test(String(e.message))) {
          delete body.reasoning_effort;
          resp = await client.chat.completions.create(body);
        } else {
          throw e;
        }
      }
      return { content: resp.choices?.[0]?.message?.content ?? '' };
    }
  };
}

// 简单判断图片类型（jpeg/png/webp），默认 jpeg
function guessExt(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'jpeg';
}

module.exports = {
  createProvider: createOpenAICompatibleProvider,
  readSettings, saveSettings, effectiveConfig, PRESETS,
  BASE_URL: 'https://opencode.ai/zen/go/v1'
};
