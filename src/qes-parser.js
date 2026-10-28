/**
 * src/qes-parser.js —— EpiData .qes 文本解析（供网页"第一步生成"和 CLI 脚本共用）
 *
 * 支持两种书写格式（实测 2026-10-28 阿周的真实 qes）：
 *   新格式：{变量名} 题目文本 [字段符号] [选项编码]，如
 *     {gender} 性别 1=男 2=女 #
 *     {age} 年龄 #######.###
 *     {hid} 住院号 ____________________
 *     {admitDt} 入院日期 <yyyy/mm/dd>
 *     {ASA} ASA评分 ### (1=1级 2=2级 3=3级 4=4级 5=5级)
 *   旧格式：变量名在前或题目文本在前（变量名+字段符号）
 *
 * markdown 痕迹（> 引用、**加粗**）自动清理；* 开头为 EpiData 注释行（"不录入"）。
 *
 * 为什么解析器是确定性的、模型不许重写：
 *   最终 CSV 的列名必须是 EpiData 变量名。name 一字不差只能来自 .qes 原文，
 *   模型最多校对题目文本和 aiHint，绝不允许产生/修改变量名。
 */
'use strict';

const DATE_RE = /<yyyy\s*\/\s*mm\s*\/\s*dd>/i;
const NUM_RE = /^#+(\.#+)?$/;
const UNDERSCORE_RE = /_{3,}/;

// 从文本里抽 "1=是 2=否" 型选项编码（= 后可带一串非编码文字）
function parseValueLabels(rest) {
  const pairs = [];
  const re = /(\d+(?:\.\d+)?)\s*=\s*([^\s=]+(?:\s(?!\d+\s*=)[^\s=]+)*)/g;
  let m;
  while ((m = re.exec(rest)) !== null) {
    pairs.push({ value: Number(m[1]), text: m[2].trim() });
  }
  return pairs;
}

// 从题目文本里清掉所有字段符号，剩纯题目
function stripTokens(title) {
  return title
    .replace(DATE_RE, ' ')
    .replace(/(^|\s)#+(\.#+)?(?=\s|$)/g, ' ')   // 独立的 # / ### / #######.###
    .replace(/_{3,}/g, ' ')                     // 下划线填空线
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*#\s*$/g, '')
    .trim();
}

// 生成 aiHint（按类型套模板）
function makeHint(kind, labels) {
  if (kind === 'radio') {
    const choicesText = labels.map(l => `${l.value}=${l.text}`).join('，');
    return `在纸质问卷上勾选选项；勾选了哪个选项文字，就返回它对应的编码数字。可选编码：${choicesText}。只返回其中一个编码数字，找不到勾选时返回 null。`;
  }
  if (kind === 'number') return '手写填空，填写数字（可带小数）；未填写则返回空字符串。';
  if (kind === 'date') return '手写日期，格式为 年/月/日（yyyy/mm/dd），如 2025/03/14；未填写则返回空字符串。';
  return '手写文字，原样保留，不要改写或翻译；未填写则返回空字符串。';
}

// 带单位的数量填空（如"踝泵运动 100次""下地时间 30min"）：模型曾把"100次"原样
// 返回导致 EpiData 里是文字，统一提示只返回数字。名单按研究的变量名来，生成时命中即覆盖默认提示。
const NUM_ONLY_NAMES = new Set(['d1Ank', 'd1Leg', 'd3Ank', 'd3Leg', 'fuTime']);
const NUM_ONLY_HINT = '手写填空，只返回数字本身（如"100次"返回 100）；未填写则返回空字符串。';

function buildElement(name, kind, title, labels, inputType) {
  const el = { type: kind === 'radio' ? 'radiogroup' : 'text', name, title };
  if (inputType) el.inputType = inputType;
  el.aiHint = (el.type === 'text' && NUM_ONLY_NAMES.has(name)) ? NUM_ONLY_HINT : makeHint(kind, labels);
  if (kind === 'radio') el.choices = labels;
  return el;
}

// ---------- 新格式：{变量名} 题目 字段符号 [编码] ----------
function parseBraceLine(name, rest, lineNo, warnings) {
  let work = rest.trim();

  // 先判型（必须在使用任何清理之前——########.### 会被"剥行尾#"误删）
  const isDate = DATE_RE.test(work);
  const isText = UNDERSCORE_RE.test(work);
  const numMatch = work.match(/(^|\s)(#+(\.#+)?)(?=\s|$)/);
  const isNum = !!numMatch;

  // 剥行尾独立的 #（此刻类型已判定，不会再误伤 #######.###）
  work = work.replace(/(^|\s)#+(?=\s|$)/g, ' ').trim();

  // 括号内编码：### (1=1级 2=2级 ...) —— 数值字段但按编码单选
  let labels = [];
  const paren = work.match(/\(([^)]*\d+\s*=\s*[^)]+)\)/);
  if (paren) {
    labels = parseValueLabels(paren[1]);
    work = (work.slice(0, paren.index) + ' ' + work.slice(paren.index + paren[0].length)).trim();
  } else {
    labels = parseValueLabels(work);
    if (labels.length) {
      work = work.replace(/(\d+(?:\.\d+)?)\s*=\s*([^\s=]+(?:\s(?!\d+\s*=)[^\s=]+)*)/g, ' ').trim();
    }
  }

  const title = stripTokens(work);

  if (labels.length > 0) {
    return buildElement(name, 'radio', title || name, labels);
  }
  if (isDate) {
    return buildElement(name, 'date', title || name, null, 'date');
  }
  if (isNum) {
    return buildElement(name, 'number', title || name, null, 'number');
  }
  if (isText) {
    return buildElement(name, 'text', title || name, null, undefined);
  }
  // 什么符号都没有：默认按文字处理，但必须警告（绝不静默定类型）
  warnings.push(`第 ${lineNo} 行变量 {${name}} 未识别到字段符号（<yyyy/mm/dd>、#、下划线），已默认按文字填空处理——请人工核对类型。题目：${title || '（空）'}`);
  return buildElement(name, 'text', title || name, null, undefined);
}

// ---------- 旧格式：变量名在前 / 题目文本在前 ----------
function parseLegacyLine(raw, lineNo, warnings) {
  const TYPE_RE = '(?:#+(?:\\.#+)?|<[Aa_][Aa0-9_]*>|<yyyy\\s*/\\s*mm\\s*/\\s*dd>|<Y>)';
  const NAME_RE = '([A-Za-z][A-Za-z0-9_]*)';
  let m = raw.match(new RegExp(`^${NAME_RE}\\s+(${TYPE_RE})\\s*(.*)$`));
  if (!m) {
    const m2 = raw.match(new RegExp(`^(.*?)\\s+${NAME_RE}\\s+(${TYPE_RE})\\s*$`));
    if (m2) m = [raw, m2[2], m2[3], m2[1]];
  }
  if (!m) return null;
  const [, name, typeToken, rest] = m;
  const labels = parseValueLabels(rest || '');
  const title = labels.length > 0 ? stripTokens(rest) : (rest || name).trim();
  if (labels.length > 0) return buildElement(name, 'radio', title || name, labels);
  if (/^#+(\.#+)?$/.test(typeToken)) return buildElement(name, 'number', title || name, null, 'number');
  if (/^<Y>$/i.test(typeToken)) {
    return buildElement(name, 'radio', title || name, [{ value: 1, text: '是' }, { value: 0, text: '否' }]);
  }
  if (DATE_RE.test(typeToken)) return buildElement(name, 'date', title || name, null, 'date');
  return buildElement(name, 'text', title || name, null, undefined);
}

/**
 * 解析 .qes 文本
 * @returns {{ elements: object[], warnings: string[] }}
 * 解析不了的行进 warnings，绝不静默丢弃。
 */
function parseQes(text) {
  const warnings = [];
  const elements = [];
  const seenNames = new Set();

  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    // 整行被 ** 包裹的是分节标题（如 **髋部骨折**），跳过
    if (/^\s*\*{2}.+\*{2}\s*$/.test(original)) continue;
    // 清理 markdown 痕迹：引用符、加粗、行首空白
    let raw = original
      .replace(/^\s*>\s?/, '')
      .replace(/\*\*/g, '')
      .trim();
    if (!raw) continue;
    if (raw.startsWith('*')) continue; // EpiData 注释行（含"不录入"说明）

    // 新格式：{变量名} 开头
    const brace = raw.match(/^\{([A-Za-z][\w]*)\}\s*(.*)$/);
    if (brace) {
      const name = brace[1];
      if (seenNames.has(name)) {
        warnings.push(`第 ${i + 1} 行变量名重复：${name}（EpiData 结构里变量名必须唯一）`);
        continue;
      }
      seenNames.add(name);
      elements.push(parseBraceLine(name, brace[2], i + 1, warnings));
      continue;
    }

    // 旧格式兜底
    const legacy = parseLegacyLine(raw, i + 1, warnings);
    if (legacy) {
      if (seenNames.has(legacy.name)) {
        warnings.push(`第 ${i + 1} 行变量名重复：${legacy.name}`);
        continue;
      }
      seenNames.add(legacy.name);
      elements.push(legacy);
      continue;
    }

    warnings.push(`第 ${i + 1} 行无法解析：${raw}`);
  }
  return { elements, warnings };
}

// 根级 aiHint：对所有字段生效的文档级提示（识别库渲染为顶层 Hint 行）
function wrapSurvey(elements, title) {
  return {
    title: title || '纸质问卷数字化',
    aiHint: '这是一份人工填写完成的纸质问卷（可能多页）。选择题为打勾标记；填空题为手写内容；日期为手写年/月/日。请逐字段仔细比对纸面内容作答，问卷上没有的字段返回 null。',
    elements
  };
}

/**
 * 生成人工校验清单（Markdown）
 */
function buildChecklist(survey, warnings, sourceName, extraRows) {
  const rows = survey.elements.map(el => {
    const choices = el.choices ? el.choices.map(c => `${c.value}=${c.text}`).join(' ') : '—';
    const kind = el.type === 'radiogroup' ? '单选' : el.inputType === 'number' ? '数字' : el.inputType === 'date' ? '日期' : '文本';
    return `| ${el.name} | ${el.title} | ${el.type}${el.inputType ? ' / ' + el.inputType : ''} | ${choices} | ${kind} |`;
  }).join('\n');

  const extra = (extraRows || []).map(r => `- **${r.name}**：${r.note}`).join('\n');
  return `# survey.json 人工校验清单

> 来源：${sourceName}。**生成后必须逐项核对，重点盯前三列。**

| 变量名(name) | 题目文本(title) | 类型 | 选项编码(value=text) | 备注 |
|---|---|---|---|---|
${rows}

## 核对要点

1. **name 必须和 EpiData 变量名一字不差**（这是导出 CSV 的列名，不能改、不能翻译、不能简化）。
2. **radiogroup 的 choices.value 必须和 EpiData 选项编码一致**（1=男 2=女 就必须是 value:1/value:2）。
3. **文字题字段宽度**：确认 EpiData 里该变量的字段宽度能容纳手写内容。
4. **数字/日期题**：确认问卷上确实按对应格式填写。
5. **aiHint**：逐条读一遍，检查是否准确描述了问卷上的勾选/填空方式。
${extra ? '\n## 模型校对结果（示例问卷照片）\n\n' + extra : ''}
${warnings.length ? '## ⚠️ 解析警告（请人工处理）\n\n' + warnings.map(w => '- ' + w).join('\n') : '## 解析警告\n\n无。'}
`;
}

module.exports = { parseQes, wrapSurvey, buildChecklist };
