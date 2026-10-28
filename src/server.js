/**
 * src/server.js —— 单机 Web 应用入口
 *
 * 启动：npm start → 浏览器访问 http://localhost:3000
 * 数据全部落在本项目 data/ 目录下，备份 = 整个项目目录拷一份。
 */
'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { toCsv, mergeCsv } = require('./csv');
const { createRecognizer } = require('./recognize');
const { readSettings, saveSettings, effectiveConfig, PRESETS } = require('./provider');
const { parseQes, wrapSurvey, buildChecklist } = require('./qes-parser');
const { calibrateSurvey } = require('./calibrate');
const { runPool } = require('./pool');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

// 旧版单问卷数据（根 survey.json / data/images / data/responses）一次性迁入 default 档案
if (store.migrateLegacy()) console.log('已将旧版单问卷数据迁入档案 default。');
store.ensureDirs();

// survey.json 是唯一 schema 源；网页"第一步生成"会重写它，loadSurvey 让
// 识别/导出立即改用新结构（不用重启）。没有结构时 survey=null（提示先去①生成）。
let survey = null;
function loadSurvey() {
  const p = store.surveyFile();
  survey = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}
loadSurvey();

const app = express();
app.use(express.json({ limit: '100mb' }));
// 每种问卷一个档案；settings.json 的 active 决定当前用哪份。
// 每个请求先定好当前档案（单线程，middleware 里设一次全链路生效）。
app.use((req, res, next) => { store.setActiveProfile(readSettings().active); next(); });
app.use(express.static(path.join(ROOT, 'public')));
// 问卷图片：审核页左侧展示用（当前档案的 images 目录，随档案切换）
app.use('/images', (req, res, next) => {
  res.sendFile(path.join(store.imageDir(), path.basename(decodeURIComponent(req.path))));
});
// SurveyJS 前端库直接从 node_modules 静态服务，离线也能用、不用 CDN
app.use('/vendor/survey-core', express.static(path.join(ROOT, 'node_modules/survey-core')));
app.use('/vendor/survey-js-ui', express.static(path.join(ROOT, 'node_modules/survey-js-ui')));
// PDF/Word → 图片的浏览器端转换库（MIT，随包分发，离线可用）
app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'node_modules/pdfjs-dist/build')));
app.use('/vendor/mammoth', express.static(path.join(ROOT, 'node_modules/mammoth')));
app.use('/vendor/html2canvas', express.static(path.join(ROOT, 'node_modules/html2canvas/dist')));

// ---------- 基础数据 ----------
app.get('/api/survey', (req, res) => res.json(survey));
app.get('/api/config', (req, res) => {
  const meta = store.readProfileMeta();
  res.json({
    threshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.75'),
    batchSize: parseInt(process.env.EXPORT_BATCH_SIZE || '50', 10),
    recognizerReady: !!effectiveConfig().apiKey,   // 有 Key 就绪；设置面板改完即时反映
    idVariable: meta.idVariable || '',             // 问卷编号变量（列表/审核页查重用，随档案）
    pagesPerForm: Math.max(1, parseInt(meta.pagesPerForm, 10) || 1),  // 上传预览归组用（随档案）
    profile: { id: store.activeProfile(), name: meta.name }
  });
});

// ---------- 档案（多种问卷）管理 ----------
// 每种问卷一个档案：独立的结构、照片、识别记录与导出，切换即整体切换。
app.get('/api/profiles', (req, res) => {
  res.json({ active: store.activeProfile(), list: store.listProfiles() });
});
app.post('/api/profiles', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '请给问卷档案起个名字' });
  const id = store.createProfile(name);
  const s = readSettings();
  s.active = id;
  saveSettings(s);
  store.setActiveProfile(id);
  loadSurvey();
  res.json({ ok: true, id });
});
app.post('/api/profiles/switch', (req, res) => {
  const id = store.sanitizeProfile(req.body.id);
  if (!store.listProfiles().some(p => p.id === id)) return res.status(404).json({ error: '档案不存在' });
  const s = readSettings();
  s.active = id;
  saveSettings(s);
  store.setActiveProfile(id);
  loadSurvey();
  res.json({ ok: true, id });
});
app.delete('/api/profiles/:id', (req, res) => {
  const id = store.sanitizeProfile(req.params.id);
  const list = store.listProfiles();
  if (!list.some(p => p.id === id)) return res.status(404).json({ error: '档案不存在' });
  if (list.length <= 1) return res.status(400).json({ error: '至少保留一个问卷档案' });
  store.deleteProfile(id);
  if (readSettings().active === id) {
    const s = readSettings();
    s.active = store.listProfiles()[0]?.id || 'default';
    saveSettings(s);
    store.setActiveProfile(s.active);
    loadSurvey();
  }
  res.json({ ok: true });
});

// ---------- 设置面板 ----------
// 组员在网页上自己填 API Key / 换厂商；存 data/settings.json（全档案共用）。
// "每份问卷页数 / 编号变量"是问卷相关的，存在当前档案的 profile.json 里，切换档案各自保留。
app.get('/api/settings', (req, res) => {
  const meta = store.readProfileMeta();
  res.json({
    ...readSettings(),
    pagesPerForm: meta.pagesPerForm,
    idVariable: meta.idVariable,
    presets: PRESETS,
    effective: effectiveConfig()   // 让前端知道当前实际生效的配置
  });
});
app.post('/api/settings', (req, res) => {
  const { preset, baseUrl, apiKey, model, pagesPerForm, idVariable, concurrency } = req.body;
  const s = readSettings();
  if (preset !== undefined) s.preset = String(preset);
  if (PRESETS[preset] && PRESETS[preset].baseUrl) {
    // 选了带预设端点的厂商：端点与默认模型跟随预设，避免手输错
    s.baseUrl = PRESETS[preset].baseUrl;
    if (PRESETS[preset].model) s.model = PRESETS[preset].model;
  } else if (preset === 'custom' && baseUrl !== undefined) {
    s.baseUrl = String(baseUrl).trim();
    if (model !== undefined) s.model = String(model).trim();
  }
  if (apiKey !== undefined) s.apiKey = String(apiKey).trim();
  // 并发数：同时进行的识别请求（1-6），大字段问卷提速用（全档案共用）
  const cc = parseInt(concurrency, 10);
  if (!isNaN(cc) && cc >= 1 && cc <= 6) s.concurrency = cc;
  saveSettings(s);
  // 每份页数 / 编号变量 → 当前档案
  const meta = store.readProfileMeta();
  const n = parseInt(pagesPerForm, 10);
  if (!isNaN(n) && n >= 1 && n <= 20) meta.pagesPerForm = n;
  // 问卷编号变量：用于查重（编号无固定规则，只要"不重复"这一条）
  if (idVariable !== undefined) meta.idVariable = String(idVariable).trim();
  store.writeProfileMeta(meta);
  res.json({ ...s, pagesPerForm: meta.pagesPerForm, idVariable: meta.idVariable, effective: effectiveConfig() });
});

// ---------- 后台任务系统 ----------
// 为什么：识别/校对是分钟级的长操作，压在一次 HTTP 请求里会导致
//   (1) 页面长时间只显示静态"生成中…"像死机；(2) 可能被请求超时掐断且前端漏了错误捕获。
// 改成：POST 立即返回 jobId，干活在后台，前端轮询 /api/job/:id 实时看进度。
const jobs = new Map();
function createJob() {
  const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  jobs.set(id, { status: 'running', step: '', result: null, error: null, started: Date.now() });
  // 顺手清掉一小时前的旧任务，防内存涨
  for (const [k, v] of jobs) {
    if (v.status !== 'running' && Date.now() - v.started > 3600e3) jobs.delete(k);
  }
  return id;
}
app.get('/api/job/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: '任务不存在' });
  res.json({ status: j.status, step: j.step, result: j.result, error: j.error });
});

// ---------- ① 问卷结构生成（qes + 示例问卷照片 → survey.json）----------
app.post('/api/generate-survey', (req, res) => {
  const { qesText, samplePhotos, pagesPerForm } = req.body;
  if (!qesText || !String(qesText).trim()) return res.status(400).json({ error: '缺少 .qes 文本' });

  // 同步部分（确定性解析）先做，错了快速返回不占任务
  const parsed = parseQes(String(qesText));
  if (parsed.elements.length === 0) {
    return res.status(400).json({ error: '没解析出任何字段，请检查 .qes 格式', warnings: parsed.warnings });
  }
  const draft = wrapSurvey(parsed.elements);
  const allWarnings = parsed.warnings.slice();
  const photos = (samplePhotos || []).map(p => Buffer.from(p.dataBase64, 'base64'));

  const jobId = createJob();
  const job = jobs.get(jobId);
  (async () => {
    try {
      // 第一步：模型校对（有示例照片才做；失败不影响草稿，记警告不静默）
      let calibration = null;
      if (photos.length > 0) {
        try {
          const nChunks = Math.ceil(draft.elements.length / Math.max(10, parseInt(process.env.RECOGNIZE_CHUNK_SIZE || '40', 10)));
          calibration = await calibrateSurvey(draft, String(qesText), photos,
            (i) => { job.step = `模型校对：第 ${i}/${nChunks} 块（共 ${draft.elements.length} 个字段）…`; });
          for (const el of draft.elements) {
            if (calibration.aiHints[el.name]) el.aiHint = calibration.aiHints[el.name]; // 仅限已知变量名
          }
          if (calibration.pageCount && photos.length !== calibration.pageCount) {
            allWarnings.push(`模型判断示例问卷共 ${calibration.pageCount} 页，但上传了 ${photos.length} 张照片——请核对是否漏拍/多拍。`);
          }
          for (const c of calibration.checks) {
            if (c.matches === false) allWarnings.push(`题目不一致：${c.name} 在照片上是「${c.onPaper}」——${c.note || ''}`);
          }
          allWarnings.push(...calibration.warnings);
        } catch (e) {
          allWarnings.push('模型校对失败（不影响草稿生成，可稍后重试）：' + e.message);
        }
      }

      // 第二步：每份页数 = 示例照片数（用户显式填的优先），写入当前档案供上传归组用
      job.step = '写入设置与落盘…';
      const meta = store.readProfileMeta();
      const explicitPages = parseInt(pagesPerForm, 10);
      meta.pagesPerForm = explicitPages >= 1 ? explicitPages : (photos.length || meta.pagesPerForm || 1);
      store.writeProfileMeta(meta);

      // 第三步：落盘 + 生成校验清单 + 立即切换新结构
      fs.writeFileSync(store.surveyFile(), JSON.stringify(draft, null, 2), 'utf-8');
      const checklistMd = buildChecklist(draft, allWarnings, '网页生成（qes' + (photos.length ? ` + ${photos.length} 张示例照片` : '') + '）',
        (calibration?.checks || []).map(c => ({
          name: c.name,
          note: `照片表述「${c.onPaper}」${c.matches === false ? ' ⚠️ 与 qes 不一致' : ''} ${c.note || ''}`
        })));
      fs.writeFileSync(store.checklistFile(), checklistMd, 'utf-8');
      loadSurvey();
      job.status = 'done';
      job.result = {
        survey: draft, warnings: allWarnings, checklistMd,
        pagesPerForm: meta.pagesPerForm, calibrated: !!calibration,
        note: '结构已更新。若之前上传/识别过旧结构的问卷数据，与新版变量不再对应，建议点"清空数据"重新开始。'
      };
    } catch (e) {
      job.status = 'error';
      job.error = String(e.message || e);
    }
  })();
  res.json({ jobId, fieldCount: draft.elements.length });
});

// 清空当前档案的问卷数据（图片+识别/审核记录），保留 qes、设置、导出留档
app.post('/api/reset-data', (req, res) => {
  store.ensureDirs();
  let removed = 0;
  for (const f of fs.readdirSync(store.imageDir())) { fs.unlinkSync(path.join(store.imageDir(), f)); removed++; }
  for (const f of fs.readdirSync(store.responseDir())) { fs.unlinkSync(path.join(store.responseDir(), f)); removed++; }
  res.json({ ok: true, removed });
});

// ---------- ③ 批量识别（后台任务，前端轮询进度）----------
app.post('/api/recognize-all', (req, res) => {
  if (!survey) return res.status(400).json({ error: '当前问卷还没有结构，请先在①生成 survey.json' });
  const pending = store.listResponses().filter(r => r.status === 'uploaded');
  if (pending.length === 0) return res.status(400).json({ error: '没有待识别的问卷' });
  const jobId = createJob();
  const job = jobs.get(jobId);
  (async () => {
    let recognizer;
    try {
      recognizer = createRecognizer();   // 无 Key 时这里抛错 → 任务标 error
    } catch (e) {
      job.status = 'error'; job.error = e.message; return;
    }
    // 多份问卷并发识别（设置面板"并发数"，默认 3 份同时在跑；每份内部块也并发）
    const conc = Math.max(1, parseInt(readSettings().concurrency, 10) || 3);
    let done = 0;
    const results = await runPool(pending, conc, async (p, i) => {
      const record = normalizeRecord(store.readResponse(p.id));
      const pages = record.pages.slice().sort((a, b) => a.n - b.n);
      const buffers = pages.map(x => store.readImage(x.file));
      try {
        job.step = `识别中（已完成 ${done}/${pending.length}，并行 ${Math.min(conc, pending.length - done)} 份）：当前 ${record.base}（${record.pages.length} 页）`;
        const { data, confidence } = await recognizer.recognizeImage(buffers, survey);
        record.data = data;
        record.confidence = confidence;
        record.status = 'recognized';
        record.error = '';
        record.updatedAt = new Date().toISOString();
        store.saveResponse(record);
        done++;
        job.step = `已完成 ${done}/${pending.length}`;
        return { base: record.base, ok: true };
      } catch (e) {
        record.error = String(e.message || e);
        record.updatedAt = new Date().toISOString();
        store.saveResponse(record);
        done++;
        return { base: record.base, ok: false, error: record.error };
      }
    });
    job.status = 'done';
    job.result = { count: pending.length, results };
  })();
  res.json({ jobId, count: pending.length });
});

// ---------- ② 上传 ----------
// 前端把图片读成 base64 POST 过来，避免引入 multer（少一个依赖）。
//
// 多页问卷归组规则（组员只需"按顺序拍照、整批一起上传"）：
//   1. 显式规则优先：文件名带 _p页码（0001_p1.jpg、0001_p2.jpg）→ 按编号归成一份；
//   2. 无编号后缀：按文件名自然排序（IMG_9 排在 IMG_10 前面，拍照默认名不补零也不乱），
//      每「每份页数」张（设置面板里配，默认 1 = 单页问卷）切成一份。
// 同编号同页码重传 = 覆盖旧图（拍糊重拍重传不产生重复）。
const PAGE_RE = /^(.+?)[-_]p(\d+)$/i;

function stemOf(name) { return path.basename(name, path.extname(name)); }

// 自然排序：数字段按数值比较
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// 旧版单文件记录升级为多页结构（pages: [{n, file}]），只迁移一次
function normalizeRecord(r) {
  if (!r.pages) {
    const base = (stemOf(r.originalName).match(PAGE_RE) || [null, stemOf(r.originalName), 1])[1];
    r.base = base;
    r.pages = [{ n: 1, file: r.imageFile }];
  }
  return r;
}

app.post('/api/upload', (req, res) => {
  // 两种请求都收：{name, dataBase64} 单文件 / {files:[...]} 整批
  const files = req.body.files || (req.body.name ? [{ name: req.body.name, dataBase64: req.body.dataBase64 }] : []);
  if (files.length === 0) return res.status(400).json({ error: '缺少上传文件' });
  const pagesPerForm = Math.max(1, parseInt(store.readProfileMeta().pagesPerForm, 10) || 1);

  // 第一步：按显式 _pN 规则与无后缀两类拆开
  const explicit = new Map();   // base → [{n, f}]
  const implicit = [];          // 无后缀，等待顺序切分
  for (const f of files) {
    const pm = stemOf(f.name).match(PAGE_RE);
    if (pm) {
      const base = pm[1];
      if (!explicit.has(base)) explicit.set(base, []);
      explicit.get(base).push({ n: parseInt(pm[2], 10), f });
    } else {
      implicit.push(f);
    }
  }
  implicit.sort((a, b) => naturalCompare(a.name, b.name));

  // 第二步：无后缀的按每 pagesPerForm 张切一份（问卷编号取该组第一张的文件名）
  const groups = [];
  for (const [base, arr] of explicit) {
    groups.push({ base, pages: arr.sort((a, b) => a.n - b.n) });
  }
  for (let i = 0; i < implicit.length; i += pagesPerForm) {
    const chunk = implicit.slice(i, i + pagesPerForm);
    groups.push({ base: stemOf(chunk[0].name), pages: chunk.map((f, idx) => ({ n: idx + 1, f })) });
  }

  const warnings = [];
  if (implicit.length % pagesPerForm !== 0) {
    warnings.push(`无编号后缀的图片共 ${implicit.length} 张，不是每份 ${pagesPerForm} 页的整数倍：最后一份页数不完整，请在列表里核对。`);
  }

  // 第三步：逐组落盘（新组建档，已有组覆盖对应页）
  const records = [];
  for (const g of groups) {
    let record = store.listResponses().map(normalizeRecord).find(r => r.base === g.base);
    if (!record) {
      const id = store.makeId(g.base);
      record = {
        id, base: g.base,
        pages: [],
        originalName: g.pages[0].f.name,
        status: 'uploaded',            // uploaded → recognized → confirmed
        data: {}, confidence: {}, reviewer: '', batch: '',
        error: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    }
    for (const p of g.pages) {
      const ext = (path.extname(p.f.name).slice(1) || 'jpg').toLowerCase();
      const file = store.savePage(record.id, p.n, ext, Buffer.from(p.f.dataBase64, 'base64'));
      const existingPage = record.pages.find(x => x.n === p.n);
      if (existingPage) existingPage.file = file; else record.pages.push({ n: p.n, file });
    }
    record.pages.sort((a, b) => a.n - b.n);
    record.updatedAt = new Date().toISOString();
    store.saveResponse(record);
    records.push({ base: record.base, pages: record.pages.length, id: record.id });
  }
  res.json({ records, warnings });
});

// ---------- 识别 ----------
app.post('/api/recognize/:id', async (req, res) => {
  if (!survey) return res.status(400).json({ error: '当前问卷还没有结构，请先在①生成 survey.json' });
  const record = normalizeRecord(store.readResponse(req.params.id));
  if (!record) return res.status(404).json({ error: '问卷不存在' });
  // 每次识别都按当前设置新建 recognizer：设置面板里改 Key/厂商立即生效
  let recognizer;
  try {
    recognizer = createRecognizer();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  try {
    // 多页问卷：所有页按页码排序后一次请求发给模型（模型一次看完整份问卷，
    // 避免"每页单独识别再合并"导致的丢值问题——识别库文档明确警告过）
    const pages = record.pages.slice().sort((a, b) => a.n - b.n);
    const buffers = pages.map(p => store.readImage(p.file));
    const { data, confidence } = await recognizer.recognizeImage(buffers, survey);
    record.data = data;
    record.confidence = confidence;
    record.status = 'recognized';
    record.error = '';
    record.updatedAt = new Date().toISOString();
    store.saveResponse(record);
    res.json(record);
  } catch (e) {
    record.error = String(e.message || e);
    store.saveResponse(record);
    res.status(500).json({ error: record.error });
  }
});

// ---------- 问卷列表 / 单份读写（审核结果保存在这里）----------
app.get('/api/responses', (req, res) => {
  res.json(store.listResponses().sort((a, b) => a.id.localeCompare(b.id)));
});
app.get('/api/responses/:id', (req, res) => {
  const r = store.readResponse(req.params.id);
  if (!r) return res.status(404).json({ error: '问卷不存在' });
  res.json(r);
});
// 审核页"保存修改 / 标记已确认"都走这里
app.post('/api/responses/:id', (req, res) => {
  const record = store.readResponse(req.params.id);
  if (!record) return res.status(404).json({ error: '问卷不存在' });
  const { data, confirmed, reviewer } = req.body;
  if (data !== undefined) record.data = data;
  record.reviewer = reviewer ?? record.reviewer;
  if (confirmed) {
    record.status = 'confirmed';
    if (!record.batch) record.batch = req.body.batch || '';
  }
  record.updatedAt = new Date().toISOString();
  store.saveResponse(record);
  res.json(record);
});
// 列表里的"删除"：删掉记录 json 与该份的所有页图片（前端有确认框）
app.delete('/api/responses/:id', (req, res) => {
  const ok = store.deleteResponse(req.params.id);
  if (!ok) return res.status(404).json({ error: '问卷不存在' });
  res.json({ ok: true });
});

// ---------- 导出 CSV ----------
// 文件名带批次号/审核人/日期：batch01_张三_20261028.csv（审核人等元数据不进 CSV 列）
app.get('/api/export', (req, res) => {
  if (!survey) return res.status(400).json({ error: '当前问卷还没有结构，请先在①生成 survey.json' });
  const confirmedOnly = req.query.confirmedOnly !== '0';
  const all = store.listResponses().sort((a, b) => a.id.localeCompare(b.id));
  const rows = all
    .filter(r => !confirmedOnly || r.status === 'confirmed')
    .map(r => r.data);
  if (rows.length === 0) return res.status(400).json({ error: '没有可导出的问卷' });
  const csv = toCsv(survey.elements, rows);
  const batch = (req.query.batch || 'batch').replace(/[^\w\u4e00-\u9fa5-]/g, '');
  const reviewer = (req.query.reviewer || '').replace(/[^\w\u4e00-\u9fa5-]/g, '');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const filename = [batch, reviewer, date].filter(Boolean).join('_') + '.csv';
  // 同时留档到当前档案的 exports/，方便以后回溯
  const exportsDir = store.exportsDir();
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.writeFileSync(path.join(exportsDir, filename), csv, 'utf-8');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(csv);
});

// ---------- 合并 CSV ----------
app.post('/api/merge', (req, res) => {
  try {
    const texts = (req.body.files || []).map(f => f.content);
    const merged = mergeCsv(texts);
    const filename = `merged_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    const exportsDir = store.exportsDir();
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.writeFileSync(path.join(exportsDir, filename), merged.csv, 'utf-8');
    res.json({ ...merged, filename, csv: merged.csv });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  const cfg = effectiveConfig();
  const meta = store.readProfileMeta();
  console.log(`已启动：http://localhost:${PORT}`);
  console.log(`当前问卷档案：${meta.name}（${survey ? survey.elements.length + ' 个字段' : '尚未生成结构，请打开网页在①生成'}）；识别引擎：${cfg.apiKey ? '就绪（' + cfg.baseUrl + ' / ' + cfg.model + '）' : '未就绪（打开网页右上角 ⚙ 设置填 API Key）'}`);
});
