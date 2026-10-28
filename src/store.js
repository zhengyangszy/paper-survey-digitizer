/**
 * src/store.js —— 本地 JSON 文件存储（档案制，支持多种问卷）
 *
 * 为什么用本地 JSON 而不是数据库：
 *   单机使用、每人一份独立数据、线下合并，JSON 文件零配置、可直接备份（拷目录）。
 *
 * 档案（profile）：每种问卷一个独立档案目录，互不干扰，随时切换。
 *   data/profiles/<档案id>/survey.json          该问卷的结构（唯一 schema 源）
 *   data/profiles/<档案id>/survey-checklist.md  人工校验清单
 *   data/profiles/<档案id>/images/<id>_pN.ext   问卷页照片
 *   data/profiles/<档案id>/responses/<id>.json  识别/审核记录
 *   data/profiles/<档案id>/exports/             导出的批次 CSV 留档
 *   data/profiles/<档案id>/profile.json         档案元数据（显示名/每份页数/编号变量）
 * 哪个档案生效由 settings.json 的 active 决定；所有函数都对"当前档案"操作。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');

let active = 'default';
function setActiveProfile(id) { active = sanitizeProfile(id); }
function activeProfile() { return active; }

// 档案 id 只留安全字符（防路径注入/非法字符）
function sanitizeProfile(id) {
  const s = String(id || 'default').replace(/[^\w\u4e00-\u9fa5-]/g, '_').trim();
  return s || 'default';
}

function profileDir(id = active) { return path.join(PROFILES_DIR, sanitizeProfile(id)); }
function imageDir(id = active) { return path.join(profileDir(id), 'images'); }
function responseDir(id = active) { return path.join(profileDir(id), 'responses'); }
function exportsDir(id = active) { return path.join(profileDir(id), 'exports'); }
function surveyFile(id = active) { return path.join(profileDir(id), 'survey.json'); }
function checklistFile(id = active) { return path.join(profileDir(id), 'survey-checklist.md'); }
function metaFile(id = active) { return path.join(profileDir(id), 'profile.json'); }

function ensureDirs(id = active) {
  fs.mkdirSync(imageDir(id), { recursive: true });
  fs.mkdirSync(responseDir(id), { recursive: true });
}

// 由原始文件名生成安全的问卷 id（避免路径注入和非法字符）
function makeId(originalName) {
  const base = path.basename(originalName, path.extname(originalName))
    .replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  return `${Date.now().toString(36)}_${base}`;
}

function saveImage(id, ext, buffer) {
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(imageDir(), file), buffer);
  return file;
}

// 多页问卷：一页一个文件，文件名带页码，如 <id>_p2.jpg
function savePage(id, n, ext, buffer) {
  const file = `${id}_p${n}.${ext}`;
  fs.writeFileSync(path.join(imageDir(), file), buffer);
  return file;
}

function readImage(file) {
  return fs.readFileSync(path.join(imageDir(), path.basename(file)));
}

function saveResponse(record) {
  fs.writeFileSync(
    path.join(responseDir(), `${record.id}.json`),
    JSON.stringify(record, null, 2), 'utf-8'
  );
}

function readResponse(id) {
  const p = path.join(responseDir(), `${path.basename(id)}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

function listResponses() {
  ensureDirs();
  return fs.readdirSync(responseDir())
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(responseDir(), f), 'utf-8')));
}

// 删除一份问卷：记录 json + 它的所有页图片（<id>_p<n>.<ext> / 旧版 <id>.<ext>）
function deleteResponse(id) {
  const safe = path.basename(id);   // 只取文件名部分，防路径注入
  const jp = path.join(responseDir(), `${safe}.json`);
  if (!fs.existsSync(jp)) return false;
  // 精确匹配本份的图片：id 本名或 _pN 页码后缀（不会误伤同前缀的其他 id）
  const re = new RegExp(`^${safe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_p\\d+)?\\.\\w+$`);
  for (const f of fs.readdirSync(imageDir())) {
    if (re.test(f)) fs.unlinkSync(path.join(imageDir(), f));
  }
  fs.unlinkSync(jp);
  return true;
}

// ---------- 档案元数据（问卷相关设置：显示名/每份页数/编号变量）----------
function readProfileMeta(id = active) {
  const def = { name: sanitizeProfile(id), pagesPerForm: 1, idVariable: '' };
  try {
    return { ...def, ...JSON.parse(fs.readFileSync(metaFile(id), 'utf-8')) };
  } catch (e) { return def; }
}

function writeProfileMeta(meta, id = active) {
  ensureDirs(id);
  fs.writeFileSync(metaFile(id), JSON.stringify(meta, null, 2), 'utf-8');
}

// ---------- 档案管理 ----------
function createProfile(name) {
  const id = sanitizeProfile(name);
  ensureDirs(id);
  const meta = readProfileMeta(id);
  meta.name = String(name || id).trim() || id;
  writeProfileMeta(meta, id);
  return id;
}

function listProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => fs.existsSync(path.join(PROFILES_DIR, f, 'profile.json')))
    .map(id => ({ id, ...readProfileMeta(id) }));
}

function deleteProfile(id) {
  const dir = profileDir(id);
  if (!fs.existsSync(path.join(dir, 'profile.json'))) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// 旧版单问卷数据（项目根 survey.json + data/images + data/responses）一次性迁入 default 档案
// Windows 下整目录 rename 可能 EPERM（目录被占用），所以逐文件复制+删除，且每项独立判断可续迁。
function moveInto(from, to) {
  if (!fs.existsSync(from)) return;
  const st = fs.statSync(from);
  if (st.isFile()) {
    if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    fs.unlinkSync(from);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    moveInto(path.join(from, f), path.join(to, f));
  }
  if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
}

function migrateLegacy() {
  const rootSurvey = path.join(__dirname, '..', 'survey.json');
  const legacy = [
    [rootSurvey, surveyFile('default')],
    [path.join(DATA_DIR, 'survey-checklist.md'), checklistFile('default')],
    [path.join(DATA_DIR, 'images'), imageDir('default')],
    [path.join(DATA_DIR, 'responses'), responseDir('default')],
    [path.join(DATA_DIR, 'exports'), exportsDir('default')]
  ];
  if (!legacy.some(([from]) => fs.existsSync(from))) return false;
  ensureDirs('default');
  if (!fs.existsSync(metaFile('default'))) {
    const meta = readProfileMeta('default');
    meta.name = '默认问卷';
    writeProfileMeta(meta, 'default');
  }
  // 旧全局 settings 里的问卷相关参数一并带入档案（可续迁，重复执行无害）
  try {
    const old = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf-8'));
    const meta = readProfileMeta('default');
    let dirty = false;
    if (old.pagesPerForm && old.pagesPerForm > 1 && (!meta.pagesPerForm || meta.pagesPerForm <= 1)) { meta.pagesPerForm = old.pagesPerForm; dirty = true; }
    if (old.idVariable && !meta.idVariable) { meta.idVariable = old.idVariable; dirty = true; }
    if (dirty) writeProfileMeta(meta, 'default');
  } catch (e) { /* 没有 settings 就用默认 */ }
  for (const [from, to] of legacy) moveInto(from, to);
  return true;
}

module.exports = {
  setActiveProfile, activeProfile, sanitizeProfile,
  profileDir, imageDir, responseDir, exportsDir, surveyFile, checklistFile,
  ensureDirs, makeId, saveImage, savePage, readImage, saveResponse, readResponse,
  listResponses, deleteResponse,
  readProfileMeta, writeProfileMeta,
  createProfile, listProfiles, deleteProfile, migrateLegacy
};
