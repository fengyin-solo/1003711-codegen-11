/**
 * 前端自测脚本：node scripts/selftest.mjs（已被 esbuild 先打包成 .selftest.bundle.mjs）。
 * 覆盖对账包的核心业务规则：日期兼容、冲突以现场为准、存量缺失补全、
 * 同文件单批次、失败/缺失断点继续、缺失井点导出、确认后水质核查多终端只生效一次。
 */
import assert from 'node:assert/strict'

const state = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (state.has(key) ? state.get(key) : null),
    setItem: (key, value) => {
      state.set(key, String(value))
    },
    removeItem: (key) => {
      state.delete(key)
    },
  },
  addEventListener: () => {},
}

const {
  normalizeDate,
  normalizeNumber,
  parseImportText,
  hashContent,
  missingWellsCsv,
} = await import('../src/data/reconcile.ts')
const store = await import('../src/data/reconcile-store.ts')
const wq = await import('../src/api/waterquality-check.ts')
const ledger = await import('../src/data/once-ledger.ts')
const serviceModule = await import('../src/api/local-service.ts')
function import0() {
  return Promise.resolve(serviceModule)
}

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 观测日期兼容
await check('观测日期兼容多格式（点号/连字符/紧凑/中文月日/Excel序列值/时间戳）', () => {
  assert.equal(normalizeDate('2026.9.1'), '2026-09-01')
  assert.equal(normalizeDate('2026-09-02'), '2026-09-02')
  assert.equal(normalizeDate('20260903'), '2026-09-03')
  assert.equal(normalizeDate('9月5日', 2026), '2026-09-05')
  assert.equal(normalizeDate('2026/10/01 08:30'), '2026-10-01')
  // Excel 序列值 46266 → 2026-09-01（1899-12-30 起算）
  assert.equal(normalizeDate('46266'), '2026-09-01')
  assert.equal(normalizeDate('2026-09-01T10:20:00'), '2026-09-01')
  assert.equal(normalizeDate('不是日期'), null)
  assert.equal(normalizeNumber('3.26m'), 3.26)
  assert.equal(normalizeNumber(' 4.12 米 '), 4.12)
  assert.equal(normalizeNumber('abc'), null)
})

await check('表头别名与中文逗号分隔兼容', () => {
  const records = parseImportText('井号，日期，地下水埋深m，水位高程\nJG-001，2026.10.1，2.10，43.10')
  assert.equal(records.length, 1)
  assert.equal(records[0].wellCode, 'JG-001')
  assert.equal(records[0].depthText, '2.10')
  assert.equal(records[0].elevationText, '43.10')
  assert.throws(() => parseImportText('编号,数值\nA,1'), /井点编号/)
})

// 2. 导入：冲突以现场为准 + 存量缺失补全 + 缺失井点 + 失败行
store.resetReconcileData()

const fileContent = [
  '井点编号,观测日期,埋深值,水位标高,水温,观测人',
  'JG-001,2026.09.01,9.99,55.00,20.0,张三',     // 与存量冲突（埋深 3.26/标高 41.94）→ 以现场为准
  'JG-002,2026-09-02,4.12,38.68,16.0,王立群',     // 存量缺标高/水温 → 补全（42.8-4.12=38.68）
  'JG-003,2026-09-03,3.78,34.72,15.8,赵建国',     // 存量缺埋深（38.5-34.72=3.78）→ 补全
  'JG-009,2026.09.04,5.00,,16.1,李四',            // 台账没有 → 缺失井点
  'JG-001,2026-09-05,abc,,16.0,张三',             // 埋深非法且标高缺失 → 失败
  'JG-004,2026-09-06,-1.2,,17.0,赵建国',          // 负埋深 → 失败
  'JG-002,9月7日,4.30,38.50,16.3,王立群',         // 中文日期 + 闭合差 0.0 内 → 新增
].join('\n')

let outcome = store.importReconcileFile('观测对账.csv', 512, fileContent)
const batch = outcome.batch

await check('导入批次生成且计数正确（新增/补全/跳过/失败/缺失）', () => {
  assert.equal(outcome.reopened, false)
  assert.equal(batch.inserted, 1)
  assert.equal(batch.updated, 2)
  assert.equal(batch.skipped, 1)
  assert.equal(batch.failed, 2)
  assert.equal(batch.missing, 1)
  assert.equal(batch.rows.length, 7)
})

await check('现场记录与文件冲突时以现场为准（文件值不落库）', async () => {
  const { listEntries } = await import0()
  const list = listEntries('groundwater', { 井点编号: 'JG-001' }).items
  const row = list.find((item) => String(item['观测日期']) === '2026-09-01')
  assert.equal(Number(row['埋深值']), 3.26)
  assert.equal(Number(row['水位标高']), 41.94)
  const batchRow = batch.rows.find((item) => item.line === 2)
  assert.equal(batchRow.status, 'skipped')
  assert.match(batchRow.note, /以现场为准/)
})

await check('存量缺失由对账包反算补全（埋深↔标高、水温）', async () => {
  const { listEntries } = await import0()
  const jg002 = listEntries('groundwater', {}).items.find(
    (item) => item['井点编号'] === 'JG-002' && item['观测日期'] === '2026-09-02',
  )
  assert.equal(Number(jg002['水位标高']), 38.68)
  assert.equal(Number(jg002['水温']), 16.0)
  const jg003 = listEntries('groundwater', {}).items.find(
    (item) => item['井点编号'] === 'JG-003' && item['观测日期'] === '2026-09-03',
  )
  assert.equal(Number(jg003['埋深值']), 3.78)
})

// 3. 缺失井点导出
await check('缺失井点清单可导出（CSV 含编号）', () => {
  const missing = store.batchMissingWells(batch.id)
  assert.deepEqual(missing.map((item) => item.code), ['JG-009'])
  const csv = missingWellsCsv(missing)
  assert.match(csv, /井点编号,出现次数,最近观测日期,文件埋深值/)
  assert.match(csv, /JG-009,1,2026-09-04,5.00/)
})

// 4. 有失败/缺失时不能确认
await check('存在失败行或缺失井点时禁止确认批次', () => {
  assert.throws(() => store.confirmBatch(batch.id, '值班管理员'), /失败行或缺失井点/)
})

// 5. 同一文件重复导入只形成一个批次 → 走断点继续
await check('同一文件重复导入不产生新批次，自动走断点（失败行保持失败）', () => {
  const again = store.importReconcileFile('观测对账-改名.csv', 512, fileContent)
  assert.equal(again.reopened, true)
  assert.equal(again.batch.id, batch.id)
  assert.equal(store.listBatches().length, 1)
  // 缺失井点没补录前重算仍然 missing
  assert.equal(again.batch.missing, 1)
  assert.equal(again.batch.failed, 2)
})

// 6. 补录缺失井点 + 断点继续
await check('补录缺失井点后从断点继续：缺失行入账，失败行仍失败', async () => {
  const added = store.addWells(['JG-009'], '缺失井点补录')
  assert.equal(added.length, 1)
  assert.equal(store.listWells().length, 5)
  const resumed = store.resumeBatch(batch.id)
  assert.equal(resumed.missing, 0)
  assert.equal(resumed.failed, 2)
  assert.ok(resumed.inserted >= 2) // 原始新增 1 行 + JG-009 断点入账
  const { listEntries } = await import0()
  const newWellRow = listEntries('groundwater', { 井点编号: 'JG-009' }).items[0]
  assert.ok(newWellRow)
  // 新补录井点没有地面高程，只给了埋深：标高保持空，不臆造
  assert.equal(newWellRow['水位标高'], '')
  assert.equal(Number(newWellRow['埋深值']), 5.0)
  // 断点继续幂等：已导入行不重复
  const count = listEntries('groundwater', { 井点编号: 'JG-009' }).total
  assert.equal(count, 1)
})

// 7. 修正失败行后的文件 → 新批次（内容不同）
await check('修正后的文件内容 hash 不同，形成新批次；全部成功后可确认', async () => {
  const fixed = fileContent
    .replace('JG-001,2026-09-05,abc,,16.0,张三', 'JG-001,2026-09-05,3.05,,16.0,张三')
    .replace('JG-004,2026-09-06,-1.2,,17.0,赵建国', 'JG-004,2026-09-06,2.90,,17.0,赵建国')
  const second = store.importReconcileFile('观测对账-v2.csv', 480, fixed)
  assert.notEqual(second.batch.id, batch.id)
  assert.equal(store.listBatches().length, 2)
  // 第二个批次：JG-002 9月7日 在第一批次已入账 → 这次跳过；JG-001 9月1日冲突仍跳过；
  // JG-002/JG-003 已补全 → 再导一致值即 skipped；JG-001 9月5日、JG-004 9月6日新增
  assert.equal(second.batch.failed, 0)
  assert.equal(second.batch.missing, 0)
  const race = await Promise.all([
    store.confirmBatchOnce(second.batch.id, '终端A'),
    store.confirmBatchOnce(second.batch.id, '终端B'),
  ])
  assert.equal(race.filter((item) => item.applied).length, 1)
  assert.equal(race.filter((item) => !item.applied).length, 1)
  const confirmed = store.getBatch(second.batch.id)
  assert.equal(confirmed.state, 'confirmed')
  assert.ok(['终端A', '终端B'].includes(confirmed.confirmedBy))
})

await check('已确认批次拒绝重复导入', () => {
  assert.throws(() => store.importReconcileFile('x.csv', 480, hashDependentFixed()), /已在批次/)
  function hashDependentFixed() {
    return fileContent
      .replace('JG-001,2026-09-05,abc,,16.0,张三', 'JG-001,2026-09-05,3.05,,16.0,张三')
      .replace('JG-004,2026-09-06,-1.2,,17.0,赵建国', 'JG-004,2026-09-06,2.90,,17.0,赵建国')
  }
})

// 8. 确认后水质核查
await check('确认后水质核查：JG-001/JG-003 一致，台账外站点不符', async () => {
  const pending = wq.pendingCheck()
  assert.equal(pending.canCheck, true)
  const outcome1 = await wq.runWaterQualityCheck('值班管理员')
  assert.equal(outcome1.applied, true)
  assert.equal(outcome1.summary.matched, 2)
  assert.equal(outcome1.summary.unmatched, 1)
  assert.deepEqual(outcome1.summary.unmatchedSites, ['东郊取水点'])
  const { listEntries } = await import0()
  const rows = listEntries('waterquality', {}).items
  assert.match(String(rows[0]['核查结果']), /井点核对一致/)
  assert.match(String(rows[2]['核查结果']), /采样站点不在井点台账/)
})

await check('多个终端并发核查只生效一次（账本幂等）', async () => {
  // 针对同一已确认批次再次核查：不重复生效
  const outcome2 = await wq.runWaterQualityCheck('另一个终端')
  assert.equal(outcome2.applied, false)
  assert.ok(outcome2.entry.terminal)

  // runOnce 的 CAS 串行压测：同键大量调用只允许一个生效
  const key = `selftest:race:${Date.now()}`
  const calls = []
  for (let i = 0; i < 20; i += 1) {
    calls.push(await ledger.runOnce(key, `终端${i}`, () => i))
  }
  assert.equal(calls.filter((item) => item.applied).length, 1)
  assert.equal(calls.filter((item) => !item.applied).length, 19)
})

console.log(`\n全部通过：${passed} 组检查`)
