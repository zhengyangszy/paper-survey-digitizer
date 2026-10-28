/**
 * scripts/qes-to-survey.js —— CLI：.qes → survey.json + 校验清单
 * 解析逻辑在 src/qes-parser.js（与网页"第一步生成"共用同一份）。
 *
 * 用法：node scripts/qes-to-survey.js <输入.qes> [输出survey.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { parseQes, wrapSurvey, buildChecklist } = require('../src/qes-parser');

const store = require('../src/store');
store.migrateLegacy();
const input = process.argv[2] || path.join(__dirname, '..', 'data', 'qes', 'example.qes');
const output = process.argv[3] || store.surveyFile('default');   // 默认写进 default 档案

const parsed = parseQes(fs.readFileSync(input, 'utf-8'));
if (parsed.elements.length === 0) {
  console.error('没有解析出任何字段，请检查 .qes 文件格式。');
  process.exit(1);
}
const survey = wrapSurvey(parsed.elements);
store.ensureDirs('default');
fs.writeFileSync(output, JSON.stringify(survey, null, 2), 'utf-8');
console.log(`已生成 ${output}（共 ${parsed.elements.length} 个字段）`);

const checklistPath = path.join(path.dirname(output), 'survey-checklist.md');
fs.mkdirSync(path.dirname(checklistPath), { recursive: true });
fs.writeFileSync(checklistPath, buildChecklist(survey, parsed.warnings, path.basename(input)), 'utf-8');
console.log(`已生成人工校验清单 ${checklistPath}`);

if (parsed.warnings.length) {
  console.log(`\n⚠️ 有 ${parsed.warnings.length} 条解析警告，请查看校验清单末尾。`);
}
