# Paper Survey Digitizer

[中文](README.md) | **English**

Batch-digitize paper questionnaires: AI recognition → web-based human review → CSV export → import into EpiData. Runs on a single PC, zero cost, no cloud service needed.

## Quick Start

```bash
# 1. Install dependencies (Node.js >= 18 required; get the LTS from https://nodejs.org)
npm install

# 2. Configure the model: copy .env.example to .env and paste in YOUR OWN API key
copy .env.example .env

# 3. Generate survey.json from an EpiData .qes file
#    (the .qes is the single source of truth for variable names)
npm run qes -- data/qes/your-file.qes

# 4. Start the app, then open http://localhost:3000
npm start
```

> On Windows you can also double-click `启动问卷工具.bat` (starts the server and opens the browser).

## Repository Layout

```
├── 启动问卷工具.bat         Double-click launcher (starts server + browser, Windows)
├── scripts/
│   ├── make-portable.ps1   Build the portable distribution ZIP (dist\*.zip)
│   ├── qes-to-survey.js    EpiData .qes → survey.json + manual checklist (CLI)
│   ├── merge-csv.js        Offline merge of everyone's batch CSVs (no web UI needed)
│   ├── audit-csv.js        Quick audit of exported CSVs (row count / missing values)
│   └── test-vision.js      Probe whether a model can read images (run before switching models)
├── src/
│   ├── server.js           Web service (Express): structure/upload/recognize/review/export/merge APIs
│   ├── provider.js         LLM provider wrapper (OpenAI-compatible endpoints; swappable)
│   ├── recognize.js        Pipeline: page images + survey.json → answers + per-field confidence
│   ├── calibrate.js        Sample form → model calibration (question order / aiHints / page count)
│   ├── qes-parser.js       Deterministic .qes parser (shared by web UI and CLI)
│   ├── adapter.js          Lenient validation of model output (number/code type coercion)
│   ├── pool.js             Concurrency pool (per-form and per-chunk)
│   ├── store.js            Local JSON storage (no database)
│   └── csv.js              CSV export/merge (column names locked to survey.json variable order)
├── public/                 Web UI (prep page + review/export page; SurveyJS forms)
├── data/
│   ├── profiles/           One folder per questionnaire (independent structures)
│   │   └── <profile>/      survey.json + images/ + responses/ + exports/
│   │                       + survey-checklist.md + profile.json (pages per form / ID variable)
│   ├── qes/                Put your .qes files here
│   └── settings.json       Global settings (API key / vendor / concurrency; never shared)
├── dist/                   Portable distribution (built by make-portable.ps1)
└── docs/
    ├── 分工与合并说明.md    Member handbook ([English](docs/member-guide.en.md))
    └── screenshot-page1.png / page2.png  UI screenshots
```

## Data Flow (one straight line)

```
① Structure: .qes text + sample form photos (one complete form, all pages in order)
     → deterministic parse yields variable names / types / codes
       (variable names come ONLY from the .qes; the model may never change them)
     → the model cross-checks question order & wording against the photos,
       rewrites per-field aiHints, and reports the page count
     → survey.json + a manual verification checklist
     → "pages per form" is written to settings automatically
② Upload: photos / scanned PDFs / Word files (converted to page images in the browser, works offline)
     → files named with _p1/_p2 are grouped by ID; unnamed files are natural-sorted
       and cut into one form per N pages (N from settings)
     → all patients in a single PDF: split by page order; one file per patient works too
③ Recognition: all pages of one form are sent to the model in ONE request
     → long CRFs (200+ fields) are chunked (40 fields per chunk), recognized concurrently, then merged
     → reasoning disabled (reasoning_effort=none; transcription needs no reasoning, ~4x faster),
       automatic fallback if the vendor rejects the parameter
     → a 4-page form takes ~80 s in practice; result JSON includes per-field confidence
④ Review: original form on the left (multi-page, draggable split) / prefilled SurveyJS form on the right
     → low-confidence fields are highlighted red with their confidence score;
       fix them, then mark the record "confirmed"
⑤ Export: CSV (column names = survey.json variable names, one row per form) → merge (headers must match)
     → import into EpiData
```

**Multi-page forms**: all pages of one form go to the model in a **single request** (the model sees the whole form at once). Why not recognize page-by-page and merge: a page without a given question would yield a *high-confidence empty value*, which overwrites the true answer read from another page — a data-loss pattern explicitly warned against in the recognition library's docs, so it is forbidden at the code level.

The model only ever sees question titles and recognition hints (aiHint). Variable names are mapped internally by the recognition library — the model cannot create or alter them. That is the fundamental guarantee that column names never drift.

## Data & Backup

- All data lives inside the project's `data/` folder. **Backup = copy the whole project folder** (recommended after every exported batch).
- `.env` holds your API key — never share it or commit it.
- Moving to another PC: copy the project folder and run `npm install` again.

## Switching Models / Vendors

Edit `.env` (`OPENAI_BASE_URL`, `LLM_MODEL`, `OPENAI_API_KEY`). To use a completely different service, change only `src/provider.js`.

**OpenCode Go gotchas** (verified 2026-10-28):
1. **Model IDs are case-sensitive and lowercase**: `MiMo-V2.6-Flash` fails with "Model is unavailable"; use exactly what `GET /models` returns.
2. Every request needs an `x-opencode-session` header — handled automatically by provider.js (random; pin with `LLM_SESSION_ID`).
3. `deepseek-v4-flash-vision-exp` was deprecated by the vendor on 2026-10-26 — do not use it.

**Model choices** (vision required; probe with `node scripts/test-vision.js <model-id>`):
- `mimo-v2.6-flash`: cheapest (~$0.0002 per form in practice), $60 monthly credit, correctly reads checkboxes / handwritten digits / handwritten Chinese, no training on data, 0-day retention — **default recommendation**
- `gpt-6-luna`: reliable vision, similar price, 30-day abuse-monitoring logs
- `gemini-4-argon`: stronger vision, 0-day retention, smaller quota (440 requests / 5 h)

## Team Distribution (portable package)

```powershell
pwsh -File scripts\make-portable.ps1
```

Produces `dist\<name>-<date>.zip` (~55 MB) containing a portable node.exe (MIT, freely redistributable) + all dependencies + the current survey.json + the launcher. Members just **unzip → double-click the .bat → browser opens**; nothing to install.

Packaging notes:
- The package contains **no API key**: each member pastes their own key in the web UI (⚙ Settings) on first run. Your own key stays on your own machine only.
- The `data\` folder in the package is scrubbed of personal data (qes examples and the questionnaire structure only) — safe to distribute.
- Re-run the packaging script after any code or survey.json change.

## FAQ

- **"Recognition engine not ready"**: `.env` missing/misconfigured — check the first console line at startup.
- **survey.json changed**: the web app hot-reloads it; for CLI regeneration restart `npm start`.
- **CSV shows garbage in Excel**: it won't — exports carry a UTF-8 BOM (a stray character in Notepad is normal).
- **Many fields recognized wrong**: check the aiHints in survey.json against how the paper form is actually filled, fix, and re-run recognition.

## Dependencies

- [ai-form-response-extractor](https://github.com/surveyjs/ai-form-response-extractor) (official SurveyJS, MIT): multimodal recognition + confidence
- SurveyJS Form Library (MIT): review form rendering
- Express: local web service

## License

[MIT](LICENSE)
