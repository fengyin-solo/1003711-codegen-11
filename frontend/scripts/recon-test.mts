// 对账逻辑端到端验证：mock localStorage 后直接调用业务函数。
import assert from 'node:assert'

// --- mock 浏览器环境 ---
const store = new Map<string, string>()
const listeners: Array<() => void> = []
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v))
      listeners.forEach((fn) => fn())
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
  },
}
;(globalThis as any).document = undefined

const recon = await import('../src/api/groundwater-recon')
const store1 = await import('../src/data/local-store')
const batchesApi = await import('../src/data/import-batches')

const {
  normalizeObserveDate,
  parseReconFile,
  importReconFile,
  confirmReconBatch,
  exportMissingWellPoints,
  listReconBatches,
} = recon

// --- 1. 观测日期兼容 ---
assert.equal(normalizeObserveDate('2026-09-01'), '2026-09-01')
assert.equal(normalizeObserveDate('2026/9/1'), '2026-09-01')
assert.equal(normalizeObserveDate('2026.09.01'), '2026-09-01')
assert.equal(normalizeObserveDate('20260901'), '2026-09-01')
assert.equal(normalizeObserveDate('2026年9月1日'), '2026-09-01')
assert.equal(normalizeObserveDate('2026-13-01'), null)
assert.equal(normalizeObserveDate('2026-02-30'), null)
assert.equal(normalizeObserveDate('abc'), null)
console.log('✓ 观测日期兼容归一化')

// --- 2. 首次导入：新增 + 补全存量缺失 + 冲突保留现场 + 失败记录 ---
// 种子数据：GROU-0001(2026-09-01, 埋深值=地下水观测样例1 非数值→存量缺失), GROU-0002, GROU-0003
const csv = [
  '井点编号,观测日期,埋深值,水位标高',
  'GROU-0001,2026/9/1,12.5,100.2', // 存量缺失 → 文件补全
  'GROU-0002,2026年9月2日,99,88', // 与现场冲突（现场也是非数值样例 → 实际会补全）
  'WELL-A,20260903,3.2,45.6', // 新增
  'WELL-B,2026-09-04,,50.1', // 新增，埋深值缺失 → 缺失井点
  'WELL-C,not-a-date,1,2', // 失败：日期无法识别
  'WELL-D,2026-09-05,abc,2', // 失败：埋深值非数值
  ',2026-09-05,1,2', // 失败：井点编号为空
].join('\n')

const r1 = await importReconFile('recon-1.csv', csv)
assert.equal(r1.ok, true, r1.message)
assert.equal(r1.resumed, false)
const b1 = r1.batch!
assert.equal(b1.imported, 2, `imported: ${b1.imported}`)
assert.equal(b1.complemented, 2, `complemented: ${b1.complemented}`)
assert.equal(b1.failed.length, 3, `failed: ${JSON.stringify(b1.failed)}`)
assert.equal(b1.missing.length, 1, `missing: ${JSON.stringify(b1.missing)}`)
assert.equal(b1.wellCount, 6)

let rows = store1.listRows('groundwater')
const g1 = rows.find((r: any) => r['井点编号'] === 'GROU-0001')!
assert.equal(g1['埋深值'], '12.5', '存量缺失应被文件补全')
assert.equal(g1['观测日期'], '2026-09-01', '现场日期应归一化')
const wellB = rows.find((r: any) => r['井点编号'] === 'WELL-B')!
assert.equal(wellB['埋深值'], '')
assert.equal(wellB['水位标高'], '50.1')
console.log('✓ 首次导入：新增/补全/失败/缺失', r1.message)

// --- 3. 冲突以现场为准 ---
// 先让 GROU-0001 有真实数值（上一步已补全为 12.5），再导入同井点同日期不同值
const csvConflict = ['井点编号,观测日期,埋深值,水位标高', 'GROU-0001,2026-09-01,99.9,1.1'].join('\n')
const r2 = await importReconFile('recon-2.csv', csvConflict)
assert.equal(r2.batch!.conflicts, 1, r2.message)
rows = store1.listRows('groundwater')
const g1b = rows.find((r: any) => r['井点编号'] === 'GROU-0001')!
assert.equal(g1b['埋深值'], '12.5', '冲突时应保留现场值')
console.log('✓ 冲突以现场为准', r2.message)

// --- 4. 同一文件重复导入：只形成一个批次，失败井点从断点继续 ---
const before = listReconBatches().length
const r3 = await importReconFile('recon-1.csv', csv)
assert.equal(r3.resumed, true)
assert.equal(listReconBatches().length, before, '同一文件不应产生新批次')
const b3 = r3.batch!
assert.equal(b3.id, b1.id, '应复用原批次')
assert.equal(b3.failed.length, 3, '同样的坏行重试仍失败')
assert.equal(b3.imported, 2, '断点继续不重复计数')
rows = store1.listRows('groundwater')
assert.equal(rows.filter((r: any) => r['井点编号'] === 'WELL-A').length, 1, '不应重复导入')
console.log('✓ 重复导入只形成一个批次，断点继续', r3.message)

// --- 5. 确认批次：存量缺失修正 + 水质联动核查；并发只生效一次 ---
const wqBefore = store1.listRows('waterquality').length
const [c1, c2] = await Promise.all([
  confirmReconBatch(b1.id),
  confirmReconBatch(b1.id),
])
const results = [c1, c2]
assert.equal(results.filter((r) => r.followupCreated).length, 1, '核查记录只应生成一次')
assert.equal(results.filter((r) => r.alreadyConfirmed).length, 1, '并发确认应有一次幂等返回')
const wqRows = store1.listRows('waterquality')
assert.equal(wqRows.length, wqBefore + 1, '水质检测应只新增一条核查记录')
const followup = wqRows[wqRows.length - 1]
assert.equal(followup['检测人'], '对账联动')
assert.ok(String(followup['检测项目']).includes('井点水质核查'))
rows = store1.listRows('groundwater')
const wellB2 = rows.find((r: any) => r['井点编号'] === 'WELL-B')!
assert.equal(wellB2.status, '异常值', '存量缺失（WELL-B 缺埋深值）应标记异常值')
assert.equal(wellB2.abnormal, true)
const g3 = rows.find((r: any) => r['井点编号'] === 'GROU-0003')!
assert.equal(g3.status, '异常值', '种子里的非数值样例应被修正为异常值')
console.log('✓ 确认批次：存量修正 + 水质联动，并发只生效一次', c1.message, '/', c2.message)

// --- 6. 导出缺失井点：存量缺值 + 文件缺值去重 ---
const missing = exportMissingWellPoints()
assert.ok(missing.content.includes('WELL-B'), '应包含文件里缺埋深值的井点')
assert.ok(missing.content.includes('GROU-0003'), '应包含存量缺值井点')
assert.ok(missing.content.includes('存量记录'))
assert.ok(missing.content.includes('对账文件'))
const wellBLines = missing.content.split('\n').filter((l: string) => l.startsWith('WELL-B,'))
assert.equal(wellBLines.length, 1, '同一井点同一缺失项应去重')
console.log('✓ 导出缺失井点清单')

// --- 7. 无表头顺序列 + 失败清单导出 ---
const csvNoHeader = ['WELL-X,2026-09-10,1.1,2.2', 'WELL-Y,2026-09-11,3.3,4.4'].join('\n')
const parsed = parseReconFile(csvNoHeader)
assert.equal(parsed.length, 2)
assert.equal(parsed[0].wellNo, 'WELL-X')
assert.equal(parsed[0].depth, '1.1')
const failedCsv = recon.exportFailedWellPoints(b1.id)!
assert.ok(failedCsv.content.includes('WELL-C'))
assert.ok(failedCsv.content.includes('不是数值'))
console.log('✓ 无表头解析 + 失败清单导出')

console.log('\n全部对账场景验证通过')
