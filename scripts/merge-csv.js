/**
 * scripts/merge-csv.js —— 离线合并各人的批次 CSV（不需要启动 Web 应用）
 *
 * 用法：node scripts/merge-csv.js 输出.csv a.csv b.csv [c.csv ...]
 * 校验：所有文件的列名与列顺序必须完全一致，否则拒绝合并（防止错列）。
 */
'use strict';
const fs = require('fs');
const { mergeCsv } = require('../src/csv');

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log('用法：node scripts/merge-csv.js <输出.csv> <批次1.csv> <批次2.csv> [...]');
  process.exit(1);
}
const [outFile, ...inputs] = args;
try {
  const merged = mergeCsv(inputs.map(f => fs.readFileSync(f, 'utf-8')));
  fs.writeFileSync(outFile, merged.csv, 'utf-8');
  console.log(`已合并 ${merged.fileCount} 个文件，共 ${merged.rowCount} 行 → ${outFile}`);
} catch (e) {
  console.error('合并失败：' + e.message);
  process.exit(1);
}
