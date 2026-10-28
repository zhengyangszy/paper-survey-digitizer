/**
 * public/app.js —— 审核页逻辑
 *
 * 页面流程：上传 → 识别 → 列表 → 审核视图（左原图/右 SurveyJS 预填表单）→ 确认 → 导出/合并。
 * 置信度低于阈值的字段在右侧表单标红并显示置信度；审核人改动后保存或直接"标记已确认"。
 */
'use strict';

let surveyJson = null;      // survey.json（唯一 schema 源）
let config = null;          // { threshold, batchSize, recognizerReady }
let responses = [];         // 全部问卷记录
let activeIndex = -1;       // 审核视图当前指向 responses 里的下标
let surveyModel = null;     // SurveyJS 实例
let zoom = 1;               // 原图缩放
let pageIdx = 0;            // 审核视图当前页（多页问卷）

const $ = (id) => document.getElementById(id);

// ---------- 初始化 ----------
async function init() {
  [surveyJson, config] = await Promise.all([
    fetch('/api/survey').then(r => r.json()),
    fetch('/api/config').then(r => r.json())
  ]);
  renderBadge();                 // 等 survey 和 config 都到位再渲染徽章（避免显示"字段 ? 个"）
  $('thresholdInput').value = config.threshold;
  await initProfiles();          // 档案下拉（切换问卷用）
  bindEvents();
  bindStructureEvents();
  await refreshList();
}

// ---------- 问卷档案（多种问卷各自独立） ----------
async function initProfiles() {
  const { active, list } = await fetch('/api/profiles').then(r => r.json());
  const sel = $('profileSelect');
  sel.innerHTML = list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = esc(active);
  sel.onchange = async () => {
    // 切换期间禁用所有档案控件：防"切换请求还没回来又点了删除"这类连点竞态
    //（实测竞态会把删除按钮指向刚切过来的档案——误删，2026-10-28 踩过）
    sel.disabled = true;
    $('profileNewBtn').disabled = true;
    $('profileDelBtn').disabled = true;
    try {
      await fetch('/api/profiles/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sel.value })
      });
      location.reload();   // 整体切换：结构/照片/记录/导出全部跟着变，重载最干净
    } catch (e) {
      sel.disabled = false; $('profileNewBtn').disabled = false; $('profileDelBtn').disabled = false;
      alert('切换失败：' + e.message);
    }
  };
  $('profileNewBtn').onclick = async () => {
    const name = window.prompt('新问卷档案的名字（如：髋部骨折研究）：');
    if (!name || !name.trim()) return;
    const resp = await fetch('/api/profiles', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); alert('创建失败：' + (e.error || resp.status)); return; }
    location.reload();   // 新档案已设为当前，刷新后去①生成结构
  };
  $('profileDelBtn').onclick = async () => {
    const cur = list.find(p => p.id === sel.value);
    if (!window.confirm(`删除问卷档案「${cur ? cur.name : sel.value}」？\n该问卷的照片、识别/审核记录、导出留档会一起删除，不可恢复。`)) return;
    const resp = await fetch(`/api/profiles/${sel.value}`, { method: 'DELETE' });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); alert('删除失败：' + (e.error || resp.status)); return; }
    toast(`✓ 已删除问卷档案「${cur ? cur.name : sel.value}」`);
    location.reload();
  };
}

// ---------- 操作反馈（右下角黑色气泡，让人确定"刚才那下真的发生了"） ----------
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), ms);
}

function renderBadge() {
  const n = surveyJson && surveyJson.elements ? surveyJson.elements.length : null;
  $('configBadge').textContent =
    `${n != null ? `字段 ${n} 个` : '问卷结构未生成（去①生成）'} · 标红阈值 ${config.threshold} · 识别引擎 ${config.recognizerReady ? '就绪' : '未就绪（点 ⚙ 设置填 API Key）'}`;
}

// 审核页顶部的"编号重复"提示（和列表同一套查重逻辑）
function updateDupWarn() {
  const idVar = config?.idVariable;
  const record = responses[activeIndex];
  let dup = false;
  if (idVar && record) {
    const v = record.data?.[idVar];
    if (v !== null && v !== undefined && v !== '') {
      const key = String(v).trim();
      dup = responses.filter(o => String(o.data?.[idVar] ?? '').trim() === key && o.data?.[idVar] !== '' && o.data?.[idVar] != null).length > 1;
    }
  }
  $('dupWarn').style.display = dup ? '' : 'none';
}

async function loadConfigBadge() {
  config = await fetch('/api/config').then(r => r.json());
  renderBadge();
}

// ---------- 文件转图片（PDF/Word → 页图片，全部在浏览器本地完成，离线可用） ----------
// 为什么转成图片：识别库对 PDF/文档输入的支持因厂商端点而异（有的只吃图片），
// 统一转成页图片后，任何多模态模型都能用，且归组逻辑一套通吃。
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function fileToPageImages(file, onProgress) {
  const stem = file.name.replace(/\.[^.]+$/, '');
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const out = [];

  // 图片：本地压缩后再传（手机原图动辄好几 MB——上传慢、模型推理也慢）。
  // 长边压到 2000px、JPEG 质量 0.9：手写字依然清晰，体积缩到零头。
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(ext)) {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('图片无法读取：' + file.name)); img.src = URL.createObjectURL(file); });
    URL.revokeObjectURL(img.src);
    const MAX = 2000;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = 'image/jpeg';
    out.push({ name: stem + '.jpg', dataBase64: canvas.toDataURL(type, 0.9).split(',')[1] });
    return out;
  }

  // PDF：pdf.js 逐页渲染成 PNG（扫描件/电子版都适用）。
  // 一个 PDF 含所有患者的场景：页图片带 _pg 序号，交给服务端按"每份页数"顺序切分。
  if (ext === 'pdf') {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      onProgress?.(`正在转换 ${file.name}（第 ${i}/${pdf.numPages} 页）…`);
      const page = await pdf.getPage(i);
      // 渲染倍率按页面原始尺寸自适应：目标长边 ~2000px（小图放大、大图缩小）
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(1, Math.min(3, 2000 / Math.max(base.width, base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      out.push({
        name: `${stem}_pg${String(i).padStart(2, '0')}.png`,
        dataBase64: canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
      });
    }
    return out;
  }

  // Word(.docx)：优先抽取内嵌图片（扫描件插进 Word 的常见情况）；
  // 没有内嵌图就把整篇渲染成一张长图（一个 docx = 一份问卷）。
  if (ext === 'docx') {
    const buf = await file.arrayBuffer();
    let images = [];
    try {
      const raw = await mammoth.extractRawImages({ arrayBuffer: buf });
      images = raw.images || [];
    } catch (e) { /* 没有 images 转换器时走渲染路径 */ }
    if (images.length) {
      onProgress?.(`正在抽取 ${file.name} 里的 ${images.length} 张图片…`);
      for (let i = 0; i < images.length; i++) {
        const b64 = await images[i].readAsBase64();
        out.push({ name: `${stem}_img${i + 1}.png`, dataBase64: b64 });
      }
      return out;
    }
    onProgress?.(`正在渲染 ${file.name} …`);
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:900px;background:#fff;padding:40px;font-family:SimSun,serif;font-size:14px;';
    holder.innerHTML = result.value;
    document.body.appendChild(holder);
    const canvas = await html2canvas(holder, { scale: 2, backgroundColor: '#fff' });
    out.push({ name: `${stem}.png`, dataBase64: canvas.toDataURL('image/png').split(',')[1] });
    holder.remove();
    return out;
  }

  throw new Error(`不支持的文件类型：${file.name}（支持 照片/PDF/Word）`);
}

// ---------- 上传与识别 ----------
// 上传预览：与 src/server.js 同一套归组规则（显式 _pN 优先，其余自然排序按每份页数切）
// 在浏览器里先排好序、分好组、给缩略图，组员确认无误再上传——归组错了当场就能看出来。
const PAGE_RE = /^(.+?)[-_]p(\d+)$/i;
const naturalCompare = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
let pendingUpload = null;   // {files: payload, urls: [objectURL]}

function groupPreview(files, pagesPerForm) {
  const explicit = new Map();   // base → [{n, f}]
  const implicit = [];
  for (const f of files) {
    const pm = f.name.replace(/\.[^.]+$/, '').match(PAGE_RE);
    if (pm) {
      if (!explicit.has(pm[1])) explicit.set(pm[1], []);
      explicit.get(pm[1]).push({ n: parseInt(pm[2], 10), f });
    } else {
      implicit.push(f);
    }
  }
  implicit.sort((a, b) => naturalCompare(a.name, b.name));
  const groups = [];
  for (const [base, arr] of explicit) groups.push({ base, pages: arr.sort((a, b) => a.n - b.n) });
  for (let i = 0; i < implicit.length; i += pagesPerForm) {
    const chunk = implicit.slice(i, i + pagesPerForm);
    groups.push({ base: chunk[0].name.replace(/\.[^.]+$/, ''), pages: chunk.map((f, idx) => ({ n: idx + 1, f })) });
  }
  return groups;
}

function showUploadPreview(payload) {
  const pagesPerForm = Math.max(1, parseInt(config.pagesPerForm, 10) || 1);
  const groups = groupPreview(payload, pagesPerForm);
  pendingUpload = { files: payload, urls: payload.map(p => {
    const bin = atob(p.dataBase64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([u], { type: 'image/jpeg' }));
  }) };
  let urlIdx = 0;
  const html = groups.map(g =>
    `<div class="upload-group"><b>${g.base}</b><span class="hint">（${g.pages.length} 页）</span>` +
    g.pages.map(p => `<img class="thumb" src="${pendingUpload.urls[urlIdx++]}" title="${p.f.name}" data-n="${p.n}">`).join('') +
    '</div>'
  ).join('');
  const warn = payload.length % pagesPerForm !== 0 && !payload.some(p => PAGE_RE.test(p.name.replace(/\.[^.]+$/, '')))
    ? `<div style="color:#a56500">⚠️ 共 ${payload.length} 页，不是每份 ${pagesPerForm} 页的整数倍——最后一份页数可能不完整。</div>` : '';
  $('uploadPreview').innerHTML =
    `<div>已排序分组预览（按文件名自然排序，每 ${pagesPerForm} 页一份；共 ${groups.length} 份 / ${payload.length} 页）：</div>` +
    warn + html +
    `<div class="set-row"><button id="uploadConfirmBtn" class="primary">✓ 确认上传</button>` +
    `<button id="uploadCancelBtn" class="ghost">取消，重新选择</button></div>`;
  $('uploadPreview').style.display = '';
  $('uploadConfirmBtn').addEventListener('click', doUpload);
  $('uploadCancelBtn').addEventListener('click', clearUploadPreview);
}

function clearUploadPreview() {
  if (pendingUpload) { pendingUpload.urls.forEach(u => URL.revokeObjectURL(u)); pendingUpload = null; }
  $('uploadPreview').style.display = 'none';
  $('uploadPreview').innerHTML = '';
}

async function doUpload() {
  if (!pendingUpload) return;
  const payload = pendingUpload.files;
  $('uploadProgress').textContent = `共 ${payload.length} 页，上传中…`;
  const resp = await fetch('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: payload })
  });
  const result = await resp.json();
  if (!resp.ok) {
    $('uploadProgress').textContent = '上传失败：' + (result.error || resp.status);
  } else {
    const lines = result.records.map(r => `已归组：${r.base}（${r.pages} 页）`);
    lines.push(...(result.warnings || []));
    $('uploadProgress').textContent = lines.join('\n');
  }
    clearUploadPreview();
    toast(`✓ 已上传并归组 ${result.records ? result.records.length : '?'} 份（明细见下方）`);
    await refreshList();
}

async function bindEvents() {
  // 选文件 → 本地转图片 → 排序分组预览 → 确认后才真正上传
  $('fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const payload = [];
    try {
      for (const f of files) {
        payload.push(...await fileToPageImages(f, s => $('uploadProgress').textContent = s));
      }
    } catch (err) {
      $('uploadProgress').textContent = '转换失败：' + err.message;
      e.target.value = '';
      return;
    }
    $('uploadProgress').textContent = '';
    e.target.value = '';
    showUploadPreview(payload);
  });

  // 批量识别：走后台任务 + 轮询进度（每份字段多时要一两分钟，必须实时可见）
  $('recognizeAllBtn').addEventListener('click', async () => {
    const resp = await fetch('/api/recognize-all', { method: 'POST' });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      $('uploadProgress').textContent = '无法开始：' + (err.error || resp.status);
      return;
    }
    const { jobId } = await resp.json();
    $('recognizeAllBtn').disabled = true;
    try {
      const result = await pollJob(jobId, step => $('uploadProgress').textContent = step);
      // 每份的成功/失败明细（失败的可单独重试：再点一次识别按钮即可）
      const lines = (result.results || [])
        .filter(r => !r.ok)
        .map(r => `✗ ${r.base} 失败：${(r.error || '').slice(0, 120)}`);
      $('uploadProgress').textContent =
        `完成：成功 ${(result.results || []).filter(r => r.ok).length}/${result.count} 份` +
        (lines.length ? '\n' + lines.join('\n') + '\n（失败的份再点一次"识别"按钮即可重试）' : '');
    } catch (err) {
      $('uploadProgress').textContent += '\n✗ 识别中断：' + err.message;
    }
    $('recognizeAllBtn').disabled = false;
    await refreshList();
  });
}

// 轮询后台任务直到结束；onStep 收实时进度文本
async function pollJob(jobId, onStep) {
  for (;;) {
    const j = await fetch('/api/job/' + jobId).then(r => r.json());
    if (j.step) onStep?.(j.step);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(j.error || '任务失败');
    await new Promise(r => setTimeout(r, 1500));
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]); // 去掉 data: 前缀
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- ① 问卷结构生成 ----------
// 结构预览：直接读当前 survey.json，按"序号/变量名/题目/类型/选项编码"列表展示，
// 组员不用打开 JSON 文件就能核对变量名和选项编码（CSV 列名的最终依据）。
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function kindOf(el) {
  return el.type === 'radiogroup' ? '单选'
    : el.inputType === 'number' ? '数字'
    : el.inputType === 'date' ? '日期' : '文本';
}

function renderSurveyPreview(sj) {
  if (!sj || !sj.elements) { $('surveyPreviewBody').innerHTML = '<div style="padding:12px">survey.json 尚未生成。</div>'; return; }
  const rows = sj.elements.map((el, i) => {
    const choices = el.choices ? el.choices.map(c => `${c.value}=${c.text}`).join(' ') : '—';
    return `<tr><td>${i + 1}</td><td><code>${esc(el.name)}</code></td><td>${esc(el.title)}</td><td>${kindOf(el)}</td><td>${esc(choices)}</td></tr>`;
  }).join('');
  $('surveyPreviewBody').innerHTML =
    `<table><thead><tr><th>#</th><th>变量名</th><th>题目</th><th>类型</th><th>选项编码</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function showSurveyPreview() {
  surveyJson = await fetch('/api/survey').then(r => r.json());
  renderSurveyPreview(surveyJson);
  $('surveyPreviewBox').style.display = '';
  $('surveyPreviewBox').open = true;
}

async function bindStructureEvents() {
  $('previewSurveyBtn').addEventListener('click', showSurveyPreview);

  // .qes 文件选择 → 读入文本框（也可直接粘贴）
  $('qesFileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) $('qesText').value = await f.text();
  });

  // 选了示例问卷（照片/PDF/Word）：转成页图片，页数自动 = 页数（可手动改）
  $('samplePhotosInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const pages = [];
    try {
      for (const f of files) pages.push(...await fileToPageImages(f, s => $('generateMsg').textContent = s));
    } catch (err) {
      $('generateMsg').textContent = '转换失败：' + err.message;
      return;
    }
    $('pagesPerFormGen').value = pages.length;
    window.__samplePhotos = pages;   // 存起来，点"生成"时直接用（免二次转换）
    $('generateMsg').textContent = `已转换 ${pages.length} 页，每份问卷页数自动设为 ${pages.length}（可改）。`;
  });

  // 生成：qes 文本 + 示例问卷 → 确定性解析 + 模型校对 → survey.json
  $('generateSurveyBtn').addEventListener('click', async () => {
    const msg = $('generateMsg');
    const qesText = $('qesText').value.trim();
    if (!qesText) { msg.textContent = '请先粘贴 .qes 文本或选择 .qes 文件。'; return; }
    // 优先用选文件时已转换好的页图片；没有（比如直接刷新后改 qes）就现场转换
    let photos = window.__samplePhotos || [];
    if (!photos.length && $('samplePhotosInput').files.length) {
      for (const f of [...$('samplePhotosInput').files]) {
        photos.push(...await fileToPageImages(f, s => msg.textContent = s));
      }
    }
    msg.textContent = '生成中（进度见下方）…';
    $('generateSurveyBtn').disabled = true;
    try {
      const resp = await fetch('/api/generate-survey', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qesText, samplePhotos: photos, pagesPerForm: $('pagesPerFormGen').value })
      });
      const started = await resp.json();
      if (!resp.ok) {
        msg.innerHTML = `<span style="color:var(--low)">生成失败：${started.error || resp.status}</span>` +
          (started.warnings || []).map(w => `<div>· ${w}</div>`).join('');
        return;
      }
      // 后台任务 + 轮询：字段多时校对要一两分钟，进度实时显示（不再是"约十几秒"假话）
      const result = await pollJob(started.jobId, step => msg.textContent = step);
      surveyJson = result.survey;   // 前端立即切到新结构（审核/列表用它）
      const warnHtml = result.warnings.length
        ? '<div style="margin-top:6px">' + result.warnings.map(w => `<div style="color:#a56500">⚠️ ${w}</div>`).join('') + '</div>'
        : '';
      msg.innerHTML =
        `✓ 已生成：${result.survey.elements.length} 个字段 · 每份问卷页数 = ${result.pagesPerForm}` +
        (result.calibrated ? ' · 已用示例做过模型校对' : ' · 未传示例（建议补一份，校对更稳）') +
        `<div style="color:#888">${result.note}</div>` + warnHtml;
      $('checklistPre').textContent = result.checklistMd;
      $('checklistBox').style.display = '';
      renderSurveyPreview(result.survey);   // 生成完顺手把结构预览也填好
      $('surveyPreviewBox').style.display = '';
      $('surveyPreviewBox').open = true;
      await loadConfigBadge();
      await refreshList();
    } catch (err) {
      // 之前漏了这个 catch：网络断/任务失败时界面永远卡在"生成中…"
      msg.innerHTML = `<span style="color:var(--low)">生成失败：${err.message}</span>（引擎窗口里有详细报错，可重试）`;
    } finally {
      $('generateSurveyBtn').disabled = false;
    }
  });

  // 清空数据：开始真实批次前清掉试跑数据（不影响 qes/设置/导出留档）
  $('resetDataBtn').addEventListener('click', async () => {
    if (!window.confirm('清空所有已上传的问卷照片和识别/审核记录？（qes、设置、导出的 CSV 都保留）')) return;
    await fetch('/api/reset-data', { method: 'POST' });
    $('generateMsg').textContent = '已清空。';
    activeIndex = -1;
    toast('✓ 已清空所有照片与记录');
    await refreshList();
  });
}

// ---------- ⚙ 设置面板 ----------
async function openSettings() {
  $('settingsSection').style.display = '';
  const s = await fetch('/api/settings').then(r => r.json());
  const sel = $('presetSelect');
  sel.innerHTML = Object.entries(s.presets)
    .map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('');
  sel.value = s.preset || 'opencode-go';
  $('baseUrlInput').value = s.baseUrl || '';
  $('apiKeyInput').value = s.apiKey || '';
  $('modelInput').value = s.model || '';
  $('pagesPerFormInput').value = s.pagesPerForm || 1;
  // 问卷编号变量下拉：列出 survey.json 全部变量，默认选已存的
  const idSel = $('idVariableSelect');
  idSel.innerHTML = '<option value="">（不核对）</option>' +
    (surveyJson && surveyJson.elements ? surveyJson.elements : [])
      .map(e => `<option value="${e.name}">${e.name}（${e.title}）</option>`).join('');
  idSel.value = s.idVariable || '';
  $('concurrencyInput').value = s.concurrency || 3;
  $('apiKeyInput').placeholder = s.effective?.apiKey ? '已配置（留空 = 继续用现有密钥）' : '粘贴你的密钥';
  updatePresetNote(s.presets[sel.value]);
  // 切换预设：端点和默认模型跟随预设（自定义才允许手改）
  sel.onchange = () => {
    const p = s.presets[sel.value];
    $('baseUrlInput').value = p.baseUrl || '';
    if (p.model) $('modelInput').value = p.model;
    updatePresetNote(p);
  };
}

function updatePresetNote(p) {
  $('presetNote').textContent = p?.modelNote || '';
  const custom = !p?.baseUrl;
  $('baseUrlInput').disabled = !custom;
  if (!custom) $('modelInput').disabled = true; else $('modelInput').disabled = false;
}

async function saveSettings() {
  const resp = await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preset: $('presetSelect').value,
      baseUrl: $('baseUrlInput').value,
      apiKey: $('apiKeyInput').value,      // 留空 = 不改现有密钥
      model: $('modelInput').value,
      pagesPerForm: $('pagesPerFormInput').value,
      idVariable: $('idVariableSelect').value,
      concurrency: $('concurrencyInput').value
    })
  });
  const result = await resp.json();
  const msg = $('settingsMsg');
  if (!resp.ok) { msg.className = 'err'; msg.textContent = '保存失败：' + (result.error || ''); return; }
  // 醒目的成功反馈：绿色 ✓ + 4 秒后自动消失，让组员确定"保存真的发生了"
  msg.className = 'ok';
  msg.textContent = `✓ 已保存。当前生效：${result.effective.baseUrl} / ${result.effective.model}`;
  setTimeout(() => { if (msg.className === 'ok') { msg.className = ''; msg.textContent = ''; } }, 4000);
  await loadConfigBadge();   // 识别引擎就绪状态可能变化
}

// ---------- 列表 ----------
async function refreshList() {
  responses = await fetch('/api/responses').then(r => r.json());
  const tbody = $('listTable').querySelector('tbody');
  tbody.innerHTML = '';
  const threshold = parseFloat($('thresholdInput').value || config.threshold);
  // 编号查重：识别结果里同一编号出现多次 → 两份都标"编号重复"
  //（编号不按规则排，但必须唯一；重复 = 重复拍摄或归组错误，导出前必须处理）
  const idVar = config.idVariable;
  const idCount = {};
  if (idVar) {
    for (const r of responses) {
      const v = r.data?.[idVar];
      if (v === null || v === undefined || v === '') continue;
      const key = String(v).trim();
      idCount[key] = (idCount[key] || 0) + 1;
    }
  }
  const dupIds = new Set(Object.entries(idCount).filter(([, c]) => c > 1).map(([k]) => k));
  responses.forEach((r, idx) => {
    const low = lowConfidenceFields(r, threshold);
    const statusText = { uploaded: '待识别', recognized: '待审核', confirmed: '已确认' }[r.status];
    const isDup = idVar && dupIds.has(String(r.data?.[idVar] ?? '').trim()) && r.data?.[idVar] !== '' && r.data?.[idVar] != null;
    const tr = document.createElement('tr');
    const np = pagesOf(r).length;
    tr.innerHTML = `
      <td>${r.base || r.originalName}${np > 1 ? `（${np}页）` : ''}
        ${isDup ? '<span class="dup-badge">⚠️ 编号重复</span>' : ''}</td>
      <td><span class="badge ${r.status}">${statusText}</span></td>
      <td class="${low.length ? 'low-count' : ''}">${low.length ? low.length + ' 个' : '—'}</td>
      <td><button data-idx="${idx}" class="reviewBtn" ${r.status === 'uploaded' ? 'disabled' : ''}>审核</button>
        <button data-id="${esc(r.id)}" class="delBtn ghost">删除</button></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.reviewBtn').forEach(b =>
    b.addEventListener('click', () => openReview(Number(b.dataset.idx))));
  tbody.querySelectorAll('.delBtn').forEach(b =>
    b.addEventListener('click', async () => {
      const rec = responses.find(x => x.id === b.dataset.id);
      if (!rec) return;
      const np = pagesOf(rec).length;
      if (!window.confirm(`删除「${rec.base || rec.originalName}」${np > 1 ? `（${np} 页）` : ''}？\n照片和识别/审核记录会一起删除，不可恢复。`)) return;
      const resp = await fetch(`/api/responses/${rec.id}`, { method: 'DELETE' });
      if (!resp.ok) { alert('删除失败'); return; }
      if (activeIndex >= 0 && responses[activeIndex] && responses[activeIndex].id === rec.id) activeIndex = -1;
      toast(`✓ 已删除「${rec.base || rec.originalName}」（照片和记录一起删了）`);
      await refreshList();
    }));
}

// 找出低置信度字段：confidence 为 null 表示"模型认为没填"，不算低置信
function lowConfidenceFields(record, threshold) {
  if (!surveyJson || !surveyJson.elements) return [];
  return surveyJson.elements
    .filter(e => {
      const c = record.confidence?.[e.name];
      return typeof c === 'number' && c < threshold;
    })
    .map(e => e.name);
}

// ---------- 审核视图 ----------
function openReview(idx) {
  const record = responses[idx];
  if (!record || record.status === 'uploaded') return;
  activeIndex = idx;
  $('page1').style.display = 'none';
  $('page2').style.display = '';
  updateDupWarn();
  $('reviewerInput').value = record.reviewer || localStorage.getItem('reviewer') || '';
  pageIdx = 0; setPageImage();   // 多页问卷从第 1 页开始看
  buildSurveyForm(record);
  updatePosLabel();
}

// 旧记录/单页问卷统一成 pages 结构，前端只认一种形状
function pagesOf(record) {
  return record.pages || [{ n: 1, file: record.imageFile }];
}

function setPageImage() {
  const record = responses[activeIndex];
  const pages = pagesOf(record).slice().sort((a, b) => a.n - b.n);
  $('paperImg').src = `/images/${pages[pageIdx].file}`;
  $('pageLabel').textContent = `第 ${pageIdx + 1} / ${pages.length} 页`;
  $('pagePrev').disabled = pageIdx === 0;
  $('pageNext').disabled = pageIdx === pages.length - 1;
}

function buildSurveyForm(record) {
  const threshold = parseFloat($('thresholdInput').value || config.threshold);
  const flagged = new Set(lowConfidenceFields(record, threshold));
  surveyModel = new Survey.Model(surveyJson);
  surveyModel.data = record.data || {};   // 预填识别结果
  // 可选：标题前加 EpiData 变量名（导出 CSV 的列名），方便对照 EpiData/检查低置信字段
  //（开关切换走响应式原地改标题，见 showVarNames 监听器；这里只负责"打开审核页时"的初始状态）
  if ($('showVarNames').checked) {
    for (const q of surveyModel.getAllQuestions()) {
      q.__origTitle = q.title;
      q.title = `${q.name}｜${q.title}`;
    }
  }
  // 标红补写：SurveyJS 主题会覆盖 cssClasses 自定义类，且渲染是多帧异步的
  //（render() 同步返回时 DOM 还没出来，事件回调也比真实元素早 ~1.5 秒），
  // 所以渲染前清空容器、渲染后每 100ms 幂等补写一次，全部命中且过了
  // 1.5 秒宽限期才停（防后续渲染帧把类冲掉）。
  // 另一个实测坑：同一个容器节点连续两次 render，后一次会被静默丢弃（整个表单空白）
  //——所以每次渲染都换一个全新节点替换旧节点，彻底甩掉 SurveyJS 记住的渲染状态。
  const old = $('surveyContainer');
  const container = document.createElement('div');
  container.id = 'surveyContainer';
  old.replaceWith(container);
  surveyModel.render(container);
  const t0 = Date.now();
  const timer = setInterval(() => {
    let missing = false;
    for (const q of surveyModel.getAllQuestions()) {
      const el = container.querySelector(`[data-name="${q.name}"]`);
      if (!el) { missing = true; continue; }
      el.classList.toggle('q-low', flagged.has(q.name));
      // 置信度写进题目描述（SurveyJS 渲染为标题下方的 sd-description）
      const c = record.confidence?.[q.name];
      q.description = flagged.has(q.name) ? `⚠️ 识别置信度 ${c}` : '';
      q.descriptionLocation = 'underTitle';
    }
    if (!missing && Date.now() - t0 > 1500) clearInterval(timer);
  }, 100);
  setTimeout(() => clearInterval(timer), 4000); // 兜底
}

// 当前审核的是"已识别+已确认"的问卷序列（待识别的不能审）
function reviewableIndices() {
  return responses.map((r, i) => (r.status !== 'uploaded' ? i : -1)).filter(i => i >= 0);
}

function updatePosLabel() {
  const list = reviewableIndices();
  const pos = list.indexOf(activeIndex) + 1;
  const r = responses[activeIndex];
  const np = pagesOf(r).length;
  $('posLabel').textContent = `${pos} / ${list.length} · ${r.base || r.originalName}${np > 1 ? `（${np}页）` : ''}`;
}

// 保存：把右侧表单当前值写回服务端
async function saveActive(confirm) {
  const record = responses[activeIndex];
  const reviewer = $('reviewerInput').value.trim();
  if (reviewer) localStorage.setItem('reviewer', reviewer);
  if (confirm && !reviewer) {
    if (!window.confirm('审核人为空，仍要标记已确认吗？（建议填写，便于互换复核）')) return;
  }
  const body = {
    data: surveyModel.data,
    confirmed: !!confirm,
    reviewer
  };
  const resp = await fetch(`/api/responses/${record.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!resp.ok) { alert('保存失败'); return; }
  Object.assign(record, await resp.json());
  await refreshList();
  toast(confirm ? '✓ 已标记已确认（可继续审下一份）' : '✓ 已保存修改');
  // 回填后 activeIndex 可能因排序变化，重新定位到同一份
  const again = responses.findIndex(r => r.id === record.id);
  if (again >= 0) { activeIndex = again; updatePosLabel(); }
  updateDupWarn();   // 审核人可能改了编号，重查重

  // 每确认 N 份（默认 50）提醒导出批次——防止最后一次性导出出错难回溯
  const confirmedCount = responses.filter(r => r.status === 'confirmed').length;
  if (confirm && confirmedCount % config.batchSize === 0) {
    alert(`已确认满 ${confirmedCount} 份（${config.batchSize} 的整数倍）。\n建议现在到"⑤ 导出与合并"导出一个批次 CSV 并备份。`);
  }
}

function goto(offset) {
  const list = reviewableIndices();
  const pos = list.indexOf(activeIndex);
  const next = list[pos + offset];
  if (next === undefined) { alert(offset < 0 ? '已经是第一份' : '已经是最后一份'); return; }
  openReview(next);
}

// ---------- 导出与合并 ----------
function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 事件绑定（审核 + 导出）----------
$('prevBtn').addEventListener('click', () => goto(-1));
$('nextBtn').addEventListener('click', () => goto(1));
$('backBtn').addEventListener('click', () => {
  $('page2').style.display = 'none';
  $('page1').style.display = '';
  refreshList();
});
$('saveBtn').addEventListener('click', () => saveActive(false));
$('confirmBtn').addEventListener('click', () => saveActive(true));
$('thresholdInput').addEventListener('change', () => {
  // 阈值变化：不重建表单（快速重建会让前后两次渲染的异步帧互相踩踏），
  // 只在现有 DOM 上重新计算并切换标红/描述
  if (activeIndex >= 0) refreshRed();
});
// 标题显示变量名（可选开关，记住偏好）；原地切换标题——SurveyJS 对 q.title 赋值
// 会响应式更新该题 DOM，不用重建表单（重建有渲染竞态，实测会整表空白）
$('showVarNames').checked = localStorage.getItem('showVarNames') === '1';
$('showVarNames').addEventListener('change', () => {
  localStorage.setItem('showVarNames', $('showVarNames').checked ? '1' : '0');
  if (activeIndex >= 0 && surveyModel) {
    for (const q of surveyModel.getAllQuestions()) {
      if (!q.__origTitle) q.__origTitle = q.title;
      q.title = $('showVarNames').checked ? `${q.name}｜${q.__origTitle}` : q.__origTitle;
    }
  }
});

// 按当前阈值在不重建表单的前提下刷新标红与置信度描述
function refreshRed() {
  const record = responses[activeIndex];
  const threshold = parseFloat($('thresholdInput').value || config.threshold);
  const flagged = new Set(lowConfidenceFields(record, threshold));
  const container = $('surveyContainer');
  const t0 = Date.now();
  const timer = setInterval(() => {
    let missing = false;
    for (const q of surveyModel.getAllQuestions()) {
      const el = container.querySelector(`[data-name="${q.name}"]`);
      if (!el) { missing = true; continue; }
      el.classList.toggle('q-low', flagged.has(q.name));
      const c = record.confidence?.[q.name];
      q.description = flagged.has(q.name) ? `⚠️ 识别置信度 ${c}` : '';
      q.descriptionLocation = 'underTitle';
    }
    if (!missing && Date.now() - t0 > 1500) clearInterval(timer);
  }, 100);
  setTimeout(() => clearInterval(timer), 4000);
}
$('zoomIn').addEventListener('click', () => { zoom = Math.min(zoom * 1.25, 4); applyZoom(); });
$('zoomOut').addEventListener('click', () => { zoom = Math.max(zoom / 1.25, 0.4); applyZoom(); });
$('pagePrev').addEventListener('click', () => { if (pageIdx > 0) { pageIdx--; setPageImage(); } });
$('pageNext').addEventListener('click', () => { if (pageIdx < pagesOf(responses[activeIndex]).length - 1) { pageIdx++; setPageImage(); } });

// ⚙ 设置面板（开/关切换）
$('settingsBtn').addEventListener('click', () => {
  const sec = $('settingsSection');
  if (sec.style.display === 'none') openSettings();
  else sec.style.display = 'none';
});
$('saveSettingsBtn').addEventListener('click', saveSettings);

// 拖拽分隔条：调整左图/右表单宽度，记住偏好（下次打开保持）
(() => {
  const layout = $('reviewLayout'), imgPane = $('imgPane'), splitter = $('splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => { dragging = true; splitter.classList.add('active'); e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = layout.getBoundingClientRect();
    const pct = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0.15), 0.85);
    imgPane.style.flexBasis = (pct * 100).toFixed(1) + '%';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; splitter.classList.remove('active');
    localStorage.setItem('imgPaneWidth', imgPane.style.flexBasis);
  });
  // 恢复上次宽度
  const saved = localStorage.getItem('imgPaneWidth');
  if (saved) imgPane.style.flexBasis = saved;
})();
function applyZoom() {
  $('paperImg').style.width = `calc(${Math.round(zoom * 100)}% - 20px)`;
  $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
}

$('exportBtn').addEventListener('click', async () => {
  const msg = $('exportMsg');
  msg.className = ''; msg.textContent = '导出中…';
  const params = new URLSearchParams({
    batch: $('batchInput').value.trim() || 'batch',
    reviewer: $('exportReviewer').value.trim(),
    confirmedOnly: $('confirmedOnly').checked ? '1' : '0'
  });
  const resp = await fetch(`/api/export?${params}`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    msg.className = 'err'; msg.textContent = '导出失败：' + (err.error || resp.status);
    return;
  }
  const csv = await resp.text();
  const filename = decodeURIComponent(resp.headers.get('Content-Disposition').match(/filename="(.+)"/)[1]);
  downloadCsv(csv, filename);
  msg.textContent = `已导出 ${filename}（服务器同时留档在 data/exports/）`;
});

$('mergeBtn').addEventListener('click', async () => {
  const msg = $('exportMsg');
  const files = [...$('mergeInput').files];
  if (files.length < 2) { alert('请选择至少两份要合并的 CSV'); return; }
  msg.className = ''; msg.textContent = '合并中…';
  const contents = await Promise.all(files.map(f => f.text()));
  const resp = await fetch('/api/merge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: contents.map(content => ({ content })) })
  });
  const result = await resp.json();
  if (!resp.ok) {
    msg.className = 'err'; msg.textContent = '合并失败：' + result.error;
    return;
  }
  downloadCsv(result.csv, result.filename);
  msg.textContent = `已合并 ${result.fileCount} 个文件，共 ${result.rowCount} 行 → ${result.filename}（留档在 data/exports/）`;
});

init();
