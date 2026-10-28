/**
 * src/pool.js —— 定并发任务池：同时最多 limit 个在跑，结果按下标归位
 * 识别分块/多份问卷并发都用它。
 */
'use strict';

async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

module.exports = { runPool };
