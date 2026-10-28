# 纸质问卷批量数字化工具

AI 识别 → 网页人工审核 → 导出 CSV → 导入 EpiData。单机运行，零费用，无需云服务。

## 最快上手

```bash
# 1. 安装依赖（需要 Node.js ≥ 18，https://nodejs.org 下载 LTS 版）
npm install

# 2. 配置模型：复制 .env.example 为 .env，填入你的 OpenCode Go 密钥
copy .env.example .env

# 3. 由 EpiData .qes 生成 survey.json（变量名对齐的唯一事实来源）
npm run qes -- data/qes/你的文件.qes

# 4. 启动，浏览器打开 http://localhost:3000
npm start
```

## 目录结构

```
├── survey.json            问卷结构（由 .qes 生成；name=EpiData 变量名=CSV 列名，全程只定义一次）
├── 启动问卷工具.bat        双击启动（自动开浏览器；桌面快捷方式指向它）
├── scripts/
│   ├── make-portable.ps1  打便携分发包（dist\*.zip）
│   ├── qes-to-survey.js   EpiData .qes → survey.json + 人工校验清单（命令行版）
│   ├── merge-csv.js       离线合并各人的批次 CSV（不启动网页也能用）
│   └── test-vision.js     探测某模型能否看图（换模型前先跑一下）
├── src/
│   ├── server.js          Web 服务（Express）：结构生成/上传/识别/审核/导出/合并 API
│   ├── provider.js        模型调用封装（OpenAI 兼容端点，可整体替换）
│   ├── recognize.js       识别流水线：页图片 + survey.json → 答案 + 每字段置信度
│   ├── calibrate.js       示例问卷 → 模型校对（题序/aiHint/页数）
│   ├── qes-parser.js      .qes 确定性解析（网页与命令行共用）
│   ├── store.js           本地 JSON 存储（无需数据库）
│   └── csv.js             CSV 导出/合并（列名锁死为 survey.json 的变量名顺序）
├── public/                网页界面（准备页 + 审核导出页，SurveyJS 渲染表单）
├── data/
│   ├── qes/               放你的 .qes 文件
│   ├── sample/            示例问卷（试跑用，正式开录可删）
│   ├── images/            上传的问卷图片
│   ├── responses/         每份问卷的状态（识别结果、置信度、审核状态）
│   ├── exports/           导出的批次 CSV 与合并结果（自动留档）
│   └── survey-checklist.md  人工校验清单（生成 survey.json 时自动产出）
├── dist/                  便携分发包（make-portable.ps1 产出）
└── docs/
    ├── 分工与合并说明.md   给组员的操作手册
    ├── screenshot-page1.png / page2.png  界面截图
```

## 数据流（全程一条线）

```
① 问卷结构：.qes 文本 + 示例问卷照片（一份完整问卷按页序）
     → 确定性解析出变量名/类型/编码（变量名唯一合法来源，模型不许改）
     → 模型对照照片校对题序/表述 + 重写各题 aiHint + 判定总页数
     → survey.json + 人工校验清单（data/survey-checklist.md）
     → 每份问卷页数自动写入设置
② 上传照片：照片 / 扫描 PDF / Word 均可（浏览器本地转成页图片，离线可用）
     → 文件名带 _p页码 的按编号归组；无编号的自然排序后每"每份页数"张切一份
     → 所有患者整合在一个 PDF：按页序自动切成一份份；一人一个文件同样适用
③ 识别：一份问卷所有页一次请求发给模型（模型一次看完整份）
     → 真实 CRF 字段多（如 200 个），自动分块（每块 40 字段）并发识别再合并
     → 关闭思考模式（reasoning_effort=none，抄录不需要推理，快 4 倍）；厂商不支持时自动回退
     → 一份 4 页问卷实测约 80 秒；识别结果 JSON（每字段含置信度）src/recognize.js
④ 审核：左原图（可翻页，栏宽可拖拽）/ 右 SurveyJS 预填表单
     → 低置信字段整题红框红底 + 置信度标注；修改、标记"已确认"
⑤ 导出：CSV（列名 = survey.json 的变量名，一行一份）→ 合并（表头一致才允许）
     → 导入 EpiData
```

**多页问卷**：一份问卷多页时，所有页按页码排序在**一次请求**里发给模型
（模型一次看完整份问卷再作答）。为什么不按页分开识别再合并：没有某题的那一页
会被模型以"高置信度的空值"作答，按置信度合并会把另一页读到的真实答案覆盖掉
——这是识别库文档明确警告过的丢数据模式，所以代码层面禁止。

**快速启动**：双击项目里的 `启动问卷工具.bat`（自动起服务并打开浏览器）；
桌面快捷方式「问卷数字化工具」指向它。

模型只接触题目文本（title）和识别提示（aiHint）；变量名（name）由识别库内部映射，
模型不产生、不修改变量名——这是变量名对齐不出错的根本保证。

## 数据与备份

- 所有数据都在项目目录内：`data/`。**备份 = 整个项目文件夹拷贝一份**（建议每次导出批次后拷到 U 盘/网盘）。
- `.env` 里是 API 密钥，不要随项目发给别人。
- 换电脑：拷项目目录 + 重新 `npm install` 即可。

## 换模型 / 换厂商

改 `.env` 即可（`OPENAI_BASE_URL`、`LLM_MODEL`、`OPENAI_API_KEY`）。
要换到 Anthropic 官方端点或完全不同的服务，只改 `src/provider.js` 一个文件。

**OpenCode Go 两个必知的坑**（2026-10-28 实测）：
1. **模型 ID 全小写**：必须与 `GET /models` 返回值逐字一致，写成文档里的
   `MiMo-V2.6-Flash` 会报 "Model is unavailable"（网关按大小写路由）。
2. **每个请求要带 `x-opencode-session` 会话头**：provider.js 已自动处理（随机生成，
   可用 `LLM_SESSION_ID` 固定）。
3. 原方案里的 `deepseek-v4-flash-vision-exp` 已于 2026-10-26 被官方弃用，勿再使用。

**模型怎么选**（识别问卷必须是视觉模型，用 `node scripts/test-vision.js <模型ID>` 探测）：
- `mimo-v2.6-flash`：最便宜（实测单份问卷约 $0.0002），月额度 $60，实测能正确识别
  打勾题/手写数字/手写汉字，数据不训练、0 天留存——**默认推荐**
- `gpt-6-luna`：视觉可靠，价格相近，30 天滥用监控日志
- `gemini-4-argon`：视觉更强，0 天留存，额度较小（每 5 小时 440 次）

## 分发给课题组（便携版打包）

```powershell
pwsh -File scripts\make-portable.ps1
```

产出 `dist\问卷数字化工具-便携版-<日期>.zip`（约 43 MB），内含绿色版 node.exe
（MIT 许可可自由分发）+ 全部依赖 + 当前 survey.json + 启动 bat。
组员**解压 → 双击「启动问卷工具.bat」→ 浏览器自动打开**，无需安装任何东西。

打包注意：
- 包内**不含任何 API 密钥**：组员首次使用时在网页右上角 ⚙ 设置里填自己的
  Key（各自额度各花各的）；组长的密钥只留在自己电脑的 .env / settings.json 里。
- 包里的 `data\` 已清空个人数据（只留 qes 示例与问卷结构），可以放心外发。
- 代码或 survey.json 有改动后，重新跑一次打包脚本发新版。

## 常见问题

- **提示"识别引擎未就绪"**：`.env` 没配好或没保存。启动时看控制台第一行。
- **survey.json 改了**：重启 `npm start` 生效。
- **Excel 打开 CSV 乱码**：不会——导出已带 UTF-8 BOM；若用记事本打开看到 BOM 字符属正常。
- **识别错了大量字段**：先检查 survey.json 的 aiHint 是否符合问卷实际勾选方式，改完重跑识别。

## 技术依赖

- [ai-form-response-extractor](https://github.com/surveyjs/ai-form-response-extractor)（SurveyJS 官方，MIT）：多模态识别 + 置信度
- SurveyJS Form Library（MIT）：审核表单渲染
- Express：本地 Web 服务
