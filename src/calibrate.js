/**
 * src/calibrate.js —— 第一步的"模型校对"
 *
 * 输入：qes 原文 + 确定性解析出的草稿 + 示例问卷照片（一组，按页序）
 * 输出：{ pageCount, checks, aiHints, warnings }
 *
 * 铁律：模型只做校对和建议，绝不产生/修改变量名——
 *   它返回的任何未知变量名一律丢弃并记入警告（变量名只能来自 .qes 原文）。
 *
 * 分块：一两百个字段的 aiHint 一次输出会截断，按块（RECOGNIZE_CHUNK_SIZE，默认40）调用合并。
 */
'use strict';
const { createProvider } = require('./provider');

async function calibrateSurvey(draftSurvey, qesText, photoBuffers, onStep) {
  const provider = createProvider();
  const known = new Set(draftSurvey.elements.map(e => e.name));

  const CHUNK = Math.max(10, parseInt(process.env.RECOGNIZE_CHUNK_SIZE || '40', 10));
  const els = draftSurvey.elements;
  const checks = [];
  const aiHints = {};
  const warnings = [];
  let pageCount = null;

  for (let i = 0; i < els.length; i += CHUNK) {
    const chunk = els.slice(i, i + CHUNK);
    onStep?.(Math.floor(i / CHUNK) + 1, Math.ceil(els.length / CHUNK));
    const fieldList = chunk.map(e =>
      `- ${e.name}（${e.title}）：${e.type === 'radiogroup'
        ? '单选 ' + e.choices.map(c => c.value + '=' + c.text).join(' / ')
        : e.inputType === 'number' ? '数字填空' : e.inputType === 'date' ? '日期' : '文字填空'}`
    ).join('\n');

    const prompt = `下面是一份 EpiData 变量清单（变量名不可修改）和一份纸质问卷的若干页照片（按页码顺序）。
请对照照片逐项校对，只输出 JSON：
{
  "pageCount": <照片显示这份问卷的总页数>,
  "checks": [ { "name": "<变量名>", "onPaper": "<照片上该题的原始表述>", "matches": true 或 false, "note": "<差异或需注意点>" } ],
  "aiHints": { "<变量名>": "<结合实际排版重写的识别提示，每题一句话>" }
}
变量清单（只需处理这些）：
${fieldList}

.qes 原文（供比对选项编码）：
${qesText}

要求：
- checks 必须覆盖上面列出的每一个变量名，一个不多一个不少；
- aiHints 只针对列出的变量名；
- 照片上找不到某个题时，matches 填 false 并在 note 写明"照片上未见"。`;

    const resp = await provider.extractFromImage({
      image: photoBuffers,
      prompt,
      systemPrompt: '你是问卷结构校对助手。只输出合法 JSON，不要输出任何其他文字。'
    });

    // 容错解析：剥掉可能的 ```json 围栏
    const raw = resp.content.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);
    if (pageCount === null && parsed.pageCount) pageCount = parseInt(parsed.pageCount, 10) || null;

    // 铁律执行：过滤未知变量名（静默丢弃不行，要记警告）
    for (const c of parsed.checks || []) {
      if (known.has(c.name)) checks.push(c);
      else warnings.push(`模型校对返回了未知变量名 ${c.name}，已忽略（变量名只能来自 .qes）`);
    }
    for (const [name, hint] of Object.entries(parsed.aiHints || {})) {
      if (known.has(name)) aiHints[name] = String(hint);
      else warnings.push(`模型 aiHint 建议包含未知变量名 ${name}，已忽略`);
    }
  }

  return { pageCount, checks, aiHints, warnings };
}

module.exports = { calibrateSurvey };
