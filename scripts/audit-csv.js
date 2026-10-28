/** 诊断：CSV 里数字类型变量下的非数值内容逐个列出 */
'use strict';
const fs = require('fs');
const { parseCsv } = require('../src/csv');
const survey = JSON.parse(fs.readFileSync('survey.json', 'utf-8'));
const rows = parseCsv(fs.readFileSync(process.argv[2] || 'D:/Download/batch_20261028.csv', 'utf-8'));
const header = rows[0];
const byName = {};
survey.elements.forEach(e => byName[e.name] = e);

for (let r = 1; r < rows.length; r++) {
  console.log(`=== 第 ${r} 行 ===`);
  for (let c = 0; c < header.length; c++) {
    const el = byName[header[c]];
    if (!el) continue;
    const v = (rows[r][c] || '').trim();
    if (!v) continue;
    const isNumField = el.inputType === 'number';
    const looksNum = !isNaN(+v);
    if (isNumField && !looksNum) {
      console.log(`  ✗ ${el.name}（${el.title}）数字字段但值=「${v}」`);
    }
    if (!isNumField && el.inputType !== 'date' && el.type !== 'radiogroup' && /^[^,；;]{0,6}(\d+\s*(次|min|分钟|小时|ml|毫升|克|mg|mg|毫克))/.test(v)) {
      console.log(`  ⚠ ${el.name}（${el.title}）文字字段含数量式内容：「${v}」`);
    }
  }
}
