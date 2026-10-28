# Team Workflow & Merging (Member Handbook)

> One-line workflow: **① Coordinator generates the questionnaire structure → ② each member takes a batch of photos → recognize + review → ⑤ export batch CSVs → coordinator merges → cross-checking.**

Chinese version: [分工与合并说明.md](分工与合并说明.md)

## 0. Coordinator, once: generate the questionnaire structure (section ①)

1. Paste the `.qes` text (variable names, field types, question wording);
2. Photograph **one complete filled-in sample form** page by page and select all photos together —
   the page count is set automatically from the photo count (editable);
3. Click "生成 survey.json" (Generate survey.json): the system first parses the .qes deterministically
   (variable names untouched), then has the AI cross-check question order against the photos and write
   per-field recognition hints, producing a **manual verification checklist**;
4. **The coordinator must verify the checklist** (variable names match EpiData exactly, option codes
   match). Only then build the portable package and distribute it.

## 1. One-time setup (each member, on their own PC)

**Option A (recommended, nothing to install)**: unzip the portable package the coordinator sent to
any folder, double-click `启动问卷工具.bat` — the browser opens http://localhost:3000.
On first run click ⚙ Settings (top right), pick a vendor preset and paste **your own API key**;
after saving it shows "Recognition engine: ready".

**Option B (install your own environment)**: install Node.js LTS (https://nodejs.org), then:
1. Get the project folder, open a command prompt inside it (type `cmd` in the address bar) and run:
   ```
   npm install
   copy .env.example .env
   ```
2. Open `.env` in Notepad, replace the value of `OPENAI_API_KEY=` with your own key, save.
3. Start: `npm start`, open http://localhost:3000. "Recognition engine: ready" means go.

## 2. Batching rules

- The coordinator splits the material into per-person folders: `zhangsan_0001-0050`, `lisi_0051-0100`…
- **Each member works only on their own batch.** No accounts or permissions needed; everyone's data
  stays on their own PC.
- **Supported file types**: photos (jpg/png), scanned PDFs, Word (.docx) — the browser converts them
  to page images locally (the material never touches any server).
- **Grouping rules** (which pages belong to one form):
  - All patients **combined in one PDF / one stack of photos**: natural page order, one form per
    "pages per form" (set in ⚙ Settings; usually fixed when the coordinator generates survey.json
    from the sample form);
  - **One file per patient**: same rule, each file's pages split in order;
  - Explicit naming `0001_p1.jpg, 0001_p2.jpg` groups by ID (highest priority; most reliable when
    page counts vary);
  - Re-uploading the same ID + page number **overwrites** the old image (retake blurry shots freely,
    no duplicates are created).
- **Duplicate ID check**: designate the questionnaire ID as an EpiData variable and select it as
  "问卷编号变量" (ID variable) in ⚙ Settings — after recognition, the system flags duplicates:
  the same ID twice in the list or review page (red) means a duplicate shoot or a grouping error,
  and must be resolved before export.

## 3. Daily workflow (each member)

1. **Upload**: in section ② select all the material for your batch (PDF/Word/photos can be mixed;
   conversion and grouping are automatic).
2. **Recognize**: click "③ 识别所有未识别问卷" (Recognize all pending). The system automatically:
   compresses images → calls the model concurrently in chunks → merges. Long forms (100+ variables)
   take ~1–2 min each; several forms run in parallel. Wait for "完成" (done); failed forms can be
   retried by clicking the recognize button again.
3. **Review**: click 审核 (Review) in the ④ list. Left: the original image (**use the ◁ ▷ page
   buttons for multi-page forms — check every page**); right: the recognized result as a form:
   - **Red-highlighted fields** are ones the model was unsure about (confidence below threshold) —
     check each one against the original and fix;
   - Spot-check a few non-highlighted fields too (recognition is not 100% correct);
   - When done click "✓ 标记已确认" (Mark confirmed), then "下一份 →" (next).
   - Fill in your name in the "审核人" (Reviewer) box — it is remembered and written into export
     records for cross-checking traceability.
4. **Export**: when all are confirmed, fill in a batch number (assigned by the coordinator, e.g.
   `zhangsan01`) and reviewer in section ⑤, then click "导出 CSV" (Export CSV).
   - Filename looks like `zhangsan01_张三_20261028.csv` — batch/reviewer live in the filename only;
     the CSV itself contains only EpiData variable columns.
   - Every 50 confirmations (configurable) the system reminds you to export a batch.
     **Don't leave it all to one final export.**
5. **Hand in**: send the batch CSV from `data/exports/` to the coordinator (WeChat/cloud drive).

## 4. Coordinator merging

Option 1 (recommended, no web UI): put all received batch CSVs in one folder and run:
```
node scripts/merge-csv.js master.csv zhangsan_0001.csv lisi_0051.csv wangwu_0101.csv
```
Option 2: in the web UI, section ⑤, select all batch CSVs and click "合并为总 CSV" (Merge to master CSV).

**Built-in safety**: if any file's column names/order differ from the first file, merging is rejected
with an error — someone used a different survey.json version. Resolve it before merging; columns are
never silently misaligned.

## 5. Cross-checking (quality sampling)

- After merging, the coordinator splits the master table back out per person: **zhangsan reviews
  lisi's batch, lisi reviews wangwu's**, and so on.
- How: each CSV row is one form; the cross-checker samples rows against the original photos (they
  are in the other person's `data/profiles/<profile>/images/` — hand the image folder to the
  cross-checker along with the batch). Focus on free-text columns.
- Found an error: fix that record on the owner's PC (or have them fix it) and re-export the batch;
  **a changed batch must be re-exported and re-merged**.

## 6. Import into EpiData

- The final CSV's column names are the EpiData variable names, in .qes order — import directly with
  EpiData's Import feature into the .rec/.epx file.
- Row order in each batch = upload order. If you want to verify by questionnaire ID, name the image
  files by ID when uploading (e.g. `0001.jpg`).

## 7. Three rules of discipline (expensive to learn the hard way)

1. **Never edit column names or column order in a CSV** — merging will reject it and EpiData will
   misalign columns.
2. **survey.json is the single structure definition.** If a variable name or option code is wrong,
   fix the .qes → re-run `npm run qes` → **everyone re-exports**. Never patch just your own CSV.
3. **Back up after every batch export** (copy the whole `data/` folder). Recognition can be re-run;
   review labor cannot.
