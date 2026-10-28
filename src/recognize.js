/**
 * src/recognize.js —— 识别流水线
 *
 * 数据流（全项目共用这一条）：
 *   图片 + survey.json
 *     → 识别库 extractFromImage
 *     → 识别结果 JSON { data, confidence }（data 的键 = survey.json 的 name = EpiData 变量名）
 *     → 人工审核修改（审核页）
 *     → 定稿 JSON
 *     → CSV（列名 = 变量名，一行一份问卷）
 *
 * 模型只接触 title / aiHint / choices 的 text（识别人类可读内容），
 * name（EpiData 变量名）由识别库在内部做映射，模型不产生、不修改变量名。
 */
'use strict';
const { createExtractor } = require('ai-form-response-extractor');
const { createProvider, readSettings } = require('./provider');
const { runPool } = require('./pool');
const { customAdapter } = require('./adapter');

// 每次识别都重建 extractor：provider 配置（Key/厂商/模型）保存在设置面板里，
// 组员改完设置立即生效，不需要重启服务（重建只是构造几个对象，开销可忽略）
function createRecognizer() {
  return buildRecognizer();
}

function buildRecognizer() {
  const extractor = createExtractor({
    provider: createProvider(),          // 可替换的模型 provider（见 src/provider.js）
    adapter: 'custom',
    customAdapter,                       // 自定义适配器：schema 带类型收敛（见 src/adapter.js）
    options: {
      confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.75'),
      maxRetries: 2
    }
  });

  /**
   * 识别一张问卷图片
   * @param {Buffer} imageBuffer 图片文件内容
   * @param {object} formDefinition survey.json 内容
   * @returns {Promise<{data:object, confidence:object}>}
   *   data: { sex: 1, age: 35, ... }
   *   confidence: { sex: 0.98, age: 0.72, ... }（识别库返回的是数组，这里压成对象方便存取）
   */
  async function recognizeImage(imageBuffer, formDefinition, onStep) {
    // surveyjs 适配器只认 pages 结构，而 survey.json 用顶层 elements（Survey.Model 两种都认）。
    // 这里统一包装一层，保证识别库拿到它能解析的形状。
    const elements = formDefinition.pages
      ? formDefinition.pages.flatMap(p => p.elements)
      : formDefinition.elements;

    // 分块识别：真实 CRF 一两百个字段，一次调用放不下（输出截断→重试也救不回），
    // 按块（默认 40 个字段）分别调用；每块都带全部页图片，块间字段不相交，结果直接合并。
    // 块之间并发跑（设置面板"并发数"，默认 4）——实测能把一份问卷从 5 分钟压到几十秒
    const chunkSize = Math.max(10, parseInt(process.env.RECOGNIZE_CHUNK_SIZE || '40', 10));
    const chunks = [];
    for (let i = 0; i < elements.length; i += chunkSize) {
      chunks.push(elements.slice(i, i + chunkSize));
    }
    const chunkConc = Math.max(1, parseInt(readSettings().concurrency, 10) || 4);

    const chunkResults = await runPool(chunks, chunkConc, async (chunk, ci) => {
      onStep?.(ci + 1, chunks.length);
      return extractor.extractFromImage({
        image: imageBuffer,   // 单张 Buffer 或多页问卷的 Buffer 数组
        formDefinition: { ...formDefinition, pages: [{ elements: chunk }] }
      });
    });

    const data = {};
    const confidence = {};
    for (const result of chunkResults) {
      Object.assign(data, result.data || {});
      for (const c of result.confidence || []) {
        // 置信度 null 表示"模型认为该字段是空的"——审核时同样需要人工看，记为 null
        confidence[c.fieldName] = c.confidence;
      }
    }

    // 模型的单选答案可能是编码数字（1）、编码字符串（"1"）或选项文字（"男"）——
    // 统一映射回 choices.value（数字），否则审核页单选按钮预选不上、CSV 也会混格式
    for (const el of elements) {
      if (el.type === 'radiogroup' && typeof data[el.name] === 'string') {
        const v = data[el.name].trim();
        const choice = (el.choices || []).find(c => String(c.value) === v || c.text === v);
        if (choice) data[el.name] = choice.value;
      }
    }
    return { data, confidence, uniqueId: null };
  }

  return { recognizeImage };
}

module.exports = { createRecognizer };
