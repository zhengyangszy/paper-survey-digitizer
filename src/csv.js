/**
 * src/csv.js —— CSV 导出与合并
 *
 * 两条铁律（出错的代价是 EpiData 导入错列，所以代码上锁死）：
 *   1. 列名与列顺序严格按 survey.json 的元素顺序，不随用户操作、不随数据内容变化；
 *   2. 合并时要求各文件的表头（列名+顺序）完全一致才允许纵向追加行。
 *
 * CSV 里只有 EpiData 变量列。审核人/批次号写进文件名（见 server.js 的导出路由），
 * 不进 CSV——多出的列会导致 EpiData 按结构导入时错位。
 */
'use strict';

// 把一行数据的值序列化：空值输出空字符串；字符串含逗号/引号/换行时按 RFC4180 加引号
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (s === 'null' || s === 'undefined') return ''; // 模型可能把空答案字符串化
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * 生成 CSV 文本
 * @param {object[]} elements survey.json 的 elements（决定列名与顺序）
 * @param {object[]} rows 每行一个问卷的 data 对象
 */
function toCsv(elements, rows) {
  const headers = elements.map(e => e.name); // 列名 = EpiData 变量名，唯一事实来源
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  // 开头加 BOM：Excel 直接双击打开中文不乱码；EpiData 文本导入也兼容
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// 极简 RFC4180 解析器（合并别人导出的 CSV 时用）
function parseCsv(text) {
  // 去掉 BOM 和 Excel 复制时可能带的多余空白
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* 跳过，交给 \n */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * 合并多份 CSV 文本
 * @returns {{ csv: string, fileCount: number, rowCount: number }}
 * @throws 表头不一致时抛错（绝不静默合并——错列比缺数据更危险）
 */
function mergeCsv(texts) {
  const parsed = texts.map(t => parseCsv(t));
  if (parsed.length === 0) throw new Error('没有可合并的 CSV 文件');
  const header = JSON.stringify(parsed[0][0]);
  for (let i = 1; i < parsed.length; i++) {
    if (JSON.stringify(parsed[i][0]) !== header) {
      throw new Error(
        `第 ${i + 1} 个文件的列名/顺序与第一个文件不一致，拒绝合并。` +
        `请检查是否用了同一份 survey.json 导出。`
      );
    }
  }
  const lines = [parsed[0][0].join(',')];
  for (const p of parsed) {
    for (let r = 1; r < p.length; r++) lines.push(p[r].join(','));
  }
  const rowCount = lines.length - 1;
  return { csv: '\uFEFF' + lines.join('\r\n') + '\r\n', fileCount: parsed.length, rowCount };
}

module.exports = { toCsv, parseCsv, mergeCsv };
