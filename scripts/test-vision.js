/**
 * scripts/test-vision.js —— 探测某个模型能否看图（多模态）
 *
 * 用法：node scripts/test-vision.js <模型ID> [图片路径]
 * 发一张图 + 一个简短问题，能回答说明该模型支持视觉输入。
 */
'use strict';
require('dotenv').config();
const fs = require('fs');
const OpenAI = require('openai');

const model = process.argv[2] || 'mimo-v2.6-flash';
const image = process.argv[3] || 'data/sample/sample-questionnaire-0001.png';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
  // OpenCode Go 要求会话头，否则 400（见 opencode.ai/docs/go）
  defaultHeaders: {
    'x-opencode-session': 'survey-digitizer-test-' + require('crypto').randomUUID(),
    'User-Agent': 'paper-survey-digitizer/0.1'
  }
});
const dataUrl = `data:image/png;base64,${fs.readFileSync(image).toString('base64')}`;

(async () => {
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这张问卷里：1) 打勾的选项是哪些？2) 填空的数字是多少？3) 手写的文字是什么？逐项简短回答。' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }]
    });
    console.log(`[${model}] ✓ 有回复：`);
    console.log(resp.choices[0].message.content);
    console.log('usage:', JSON.stringify(resp.usage));
  } catch (e) {
    console.log(`[${model}] ✗ 失败：${String(e.message).slice(0, 300)}`);
  }
})();
