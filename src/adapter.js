/**
 * src/adapter.js —— 自定义识别适配器
 *
 * 为什么不用内置 surveyjs 适配器：它生成的 zod schema 严格要求数字字段是 number，
 * 关闭思考模式后模型会把表格数值抄成字符串（"12.3"），校验反复失败。
 * 本适配器在 schema 层做类型收敛："12.3"→12.3；单选"1"/"男"都能落到合法编码。
 *
 * zod 细节（2026-10-28 实测）：
 *   - z.enum() 不支持数字枚举 → 用 z.literal() 的 union；
 *   - z.preprocess 的内层 schema 必须自己也 .optional()——空串收敛成 undefined
 *     后是交给内层校验的，内层严格会报 Required。
 *
 * 输出铁律不变：未知字段名会被识别库的 schema 拒绝，变量名只能来自 survey.json。
 */
'use strict';
const z = require('zod');

function collect(fd) {
  return fd.pages ? fd.pages.flatMap(p => p.elements || []) : (fd.elements || []);
}

// 数值收敛：''/null → undefined（没填）；"12.3"/12 → 12.3；非数字字符串原样（交给单选/文本处理）
const coerceNum = v => (v === null || v === undefined || v === '' ? undefined
  : typeof v === 'number' ? v : (Number.isNaN(+v) ? v : +v));
const coerceStr = v => (v === null || v === undefined || v === '' ? undefined : String(v));

function zodFor(el) {
  if (el.type === 'radiogroup') {
    const vals = (el.choices || []).map(c => c.value);
    // 接受编码数字（"1"收敛为 1）或选项文字（"男"——识别后由 recognize.js 映射回编码）
    return z.preprocess(coerceNum,
      z.union([...vals.map(v => z.literal(v)), z.string()]).optional()).optional();
  }
  if (el.type === 'text' && el.inputType === 'number') {
    return z.preprocess(coerceNum, z.number().optional()).optional();
  }
  // 文字/日期：数字也收敛为字符串（模型可能把电话号码/日期报成数字）
  return z.preprocess(coerceStr, z.string().optional()).optional();
}

const customAdapter = {
  name: 'surveyjs-coerce',
  toPrompt(formDefinition) {
    const els = collect(formDefinition);
    const lines = ['从提供的问卷照片中读取以下字段的值，返回以字段名为键的 JSON 对象。'];
    if (typeof formDefinition.aiHint === 'string' && formDefinition.aiHint) {
      lines.push('', `Hint: ${formDefinition.aiHint}`);
    }
    lines.push('', 'Fields:');
    els.forEach((el, i) => {
      const kind = el.type === 'radiogroup'
        ? `单选（编码：${(el.choices || []).map(c => c.value + '=' + c.text).join('，')}）`
        : el.inputType === 'number' ? '数字填空'
        : el.inputType === 'date' ? '日期填空（格式 yyyy/mm/dd）'
        : '文字填空';
      lines.push(`${i + 1}. ${el.name} —— ${el.title}（${kind}）`);
      if (el.aiHint) lines.push(`   Hint: ${el.aiHint}`);
    });
    lines.push('', '只返回 JSON 对象，键必须是上面列出的字段名。问卷上没有的字段返回 null。');
    return lines.join('\n');
  },
  toOutputSchema(formDefinition) {
    const shape = {};
    for (const el of collect(formDefinition)) {
      shape[el.name] = zodFor(el);
    }
    return z.object(shape);
  },
  // 不需要额外归一化：收敛已在 zod preprocess 里完成
  normalizeResponseData: undefined
};

module.exports = { customAdapter };
