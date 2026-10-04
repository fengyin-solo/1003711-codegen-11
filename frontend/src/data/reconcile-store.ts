import { listRows, resetRows, saveRows, storageKey as entriesStorageKey } from './local-store'
import { notifyRemoved, readJson, removeKey, subscribeStore, writeJson } from './browser-store'
import { runOnce, type OnceResult } from './once-ledger'
import {
  RECONCILE_MODULE_KEY,
  hashContent,
  mergeRecord,
  missingWellsOf,
  parseImportText,
  recount,
  type BatchRow,
  type ImportBatch,
  type Well,
} from './reconcile'
import type { EntryRow } from './types'

// 对账包持久化：井点台账与导入批次各占一个 localStorage 键；
// 观测记录仍写回业务表（groundwater），与列表页共用一份数据。

const ROSTER_KEY = 'hydrology-monitor-station:reconcile-roster'
const BATCHES_KEY = 'hydrology-monitor-station:reconcile-batches'

export const DEFAULT_WELLS: Well[] = [
  { code: 'JG-001', name: '东郊一号井', location: '东郊镇太平村', groundElevation: 45.2, active: true, addedAt: '2026-01-10', source: '基础台账' },
  { code: 'JG-002', name: '东郊二号井', location: '东郊镇太平村', groundElevation: 42.8, active: true, addedAt: '2026-01-10', source: '基础台账' },
  { code: 'JG-003', name: '河湾观测井', location: '河湾水文站西 500m', groundElevation: 38.5, active: true, addedAt: '2026-01-10', source: '基础台账' },
  { code: 'JG-004', name: '北站水源井', location: '北站供水厂院内', groundElevation: 40.1, active: true, addedAt: '2026-01-10', source: '基础台账' },
]

let rosterCache: Well[] | null = null
let batchesCache: ImportBatch[] | null = null

function listWellsUncached(): Well[] {
  if (rosterCache === null) {
    const stored = readJson<Well[] | null>(ROSTER_KEY, null)
    rosterCache = stored ? stored.map((well) => ({ ...well })) : DEFAULT_WELLS.map((well) => ({ ...well }))
  }
  return rosterCache
}

function saveRoster(wells: Well[]): void {
  rosterCache = wells
  writeJson(ROSTER_KEY, wells)
}

function listBatchesUncached(): ImportBatch[] {
  if (batchesCache === null) {
    batchesCache = readJson<ImportBatch[]>(BATCHES_KEY, [])
  }
  return batchesCache
}

function saveBatches(batches: ImportBatch[]): void {
  batchesCache = batches
  writeJson(BATCHES_KEY, batches)
}

// 其它终端（标签页）改了 localStorage 后作废本页缓存，保证看到的是最新台账与批次。
subscribeStore((key) => {
  if (key === ROSTER_KEY) {
    rosterCache = null
  }
  if (key === BATCHES_KEY) {
    batchesCache = null
  }
})

export function listWells(): Well[] {
  return listWellsUncached().map((well) => ({ ...well }))
}

export function rosterMap(): Map<string, Well> {
  return new Map(listWellsUncached().map((well) => [well.code, well]))
}

export function addWells(codes: string[], source = '缺失井点补录'): Well[] {
  const trimmed = [...new Set(codes.map((code) => code.trim()).filter(Boolean))]
  if (trimmed.length === 0) {
    return []
  }
  const wells = listWellsUncached()
  const known = new Set(wells.map((well) => well.code))
  const added: Well[] = []
  for (const code of trimmed) {
    if (!known.has(code)) {
      const well: Well = {
        code,
        name: code,
        location: '',
        groundElevation: null,
        active: true,
        addedAt: new Date().toISOString().slice(0, 10),
        source,
      }
      wells.push(well)
      added.push({ ...well })
      known.add(code)
    }
  }
  if (added.length > 0) {
    saveRoster(wells)
  }
  return added
}

export function listBatches(): ImportBatch[] {
  return listBatchesUncached()
    .map((batch) => ({ ...batch }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getBatch(id: string): ImportBatch | undefined {
  const batch = listBatchesUncached().find((item) => item.id === id)
  return batch ? { ...batch } : undefined
}

export function latestBatch(): ImportBatch | undefined {
  const batches = listBatchesUncached()
  if (batches.length === 0) {
    return undefined
  }
  return [...batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

export function latestConfirmedBatch(): ImportBatch | undefined {
  return listBatches()
    .filter((batch) => batch.state === 'confirmed')
    .sort((a, b) => (b.confirmedAt ?? '').localeCompare(a.confirmedAt ?? ''))[0]
}

function nextRowId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function recordCode(id: number): string {
  return `GROU-${String(id).padStart(4, '0')}`
}

/** 把批次里的新增/补全结果落进地下水观测表；幂等，重复执行不会产生重复记录。 */
function applyBatchRows(batch: ImportBatch): void {
  const rows = listRows(RECONCILE_MODULE_KEY).map((row) => ({ ...row }))
  const byId = new Map(rows.map((row) => [Number(row.id), row]))
  const touched = new Set<number>()

  for (const item of batch.rows) {
    if (item.status === 'imported' && item.targetRowId !== null) {
      if (!byId.has(item.targetRowId)) {
        const row: EntryRow = {
          id: item.targetRowId,
          status: '已采集',
          pending: true,
          abnormal: item.inconsistent,
          记录编号: recordCode(item.targetRowId),
          井点编号: item.wellCode,
          观测日期: item.date ?? '',
          埋深值: item.depth ?? '',
          水位标高: item.elevation ?? '',
          水温: item.raw.waterTemp.trim(),
          观测人: item.raw.observer.trim() || '对账导入',
          记录状态: '已采集',
        }
        rows.push(row)
        byId.set(item.targetRowId, row)
        touched.add(item.targetRowId)
      }
    } else if (
      (item.status === 'updated' || item.status === 'skipped') &&
      item.existingRowId !== null
    ) {
      const row = byId.get(item.existingRowId)
      if (!row) {
        continue
      }
      // 现场缺测的字段才补；冲突字段一律保留现场值（mergeRecord 已保证 depth/elevation 与现场一致时才走到这）。
      const fillBlank = (field: string, value: string | number | null) => {
        if (value !== null && value !== '' && String(row[field] ?? '').trim() === '') {
          row[field] = value
        }
      }
      fillBlank('埋深值', item.depth)
      fillBlank('水位标高', item.elevation)
      if (item.raw.waterTemp.trim()) {
        fillBlank('水温', item.raw.waterTemp)
      }
      if (item.raw.observer.trim()) {
        fillBlank('观测人', item.raw.observer)
      }
      if (item.inconsistent) {
        row.abnormal = true
      }
      touched.add(item.existingRowId)
    }
  }

  if (touched.size > 0 || batch.inserted > 0) {
    saveRows(RECONCILE_MODULE_KEY, rows)
  }
}

function processRows(records: ReturnType<typeof parseImportText>, batch: ImportBatch): ImportBatch {
  const existingRows = listRows(RECONCILE_MODULE_KEY)
  const existingMap = new Map<string, EntryRow>()
  for (const row of existingRows) {
    existingMap.set(`${String(row['井点编号'] ?? '')}__${String(row['观测日期'] ?? '')}`, row)
  }
  let cursor = nextRowId(existingRows)
  const ctx = {
    roster: rosterMap(),
    existing: existingMap,
    allocateId: () => cursor,
  }
  const nextRows: BatchRow[] = []
  for (const rec of records) {
    const row = mergeRecord(rec, ctx)
    if (row.status === 'imported') {
      row.targetRowId = cursor
      cursor += 1
    }
    nextRows.push(row)
  }
  const next = recount({ ...batch, rows: nextRows })
  applyBatchRows(next)
  return next
}

export type ImportOutcome = { batch: ImportBatch; reopened: boolean; reprocessed: number }

/**
 * 导入对账文件：
 * - 同一文件（内容 hash 相同）只形成一个批次：已建批次则走断点继续，只重算失败/缺失井点；
 * - 已确认的批次拒绝重复处理。
 */
export function importReconcileFile(fileName: string, fileSize: number, text: string): ImportOutcome {
  const fileHash = hashContent(text)
  const batches = listBatchesUncached()
  const found = batches.find((batch) => batch.fileHash === fileHash)
  if (found) {
    if (found.state === 'confirmed') {
      throw new Error(`文件「${fileName}」已在批次 ${found.id} 对账确认，未重复导入`)
    }
    const resumed = resumeBatch(found.id)
    return { batch: resumed, reopened: true, reprocessed: resumed.rows.filter((row) => ['failed', 'missing'].includes(row.status)).length }
  }

  const records = parseImportText(text)
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
  const batch: ImportBatch = {
    id: `IMP-${stamp}-${fileHash.slice(0, 8)}`,
    fileName,
    fileSize,
    fileHash,
    createdAt: now.toISOString(),
    confirmedAt: null,
    confirmedBy: null,
    state: 'imported',
    rows: [],
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    missing: 0,
  }
  const processed = processRows(records, batch)
  saveBatches([...batches, processed])
  return { batch: processed, reopened: false, reprocessed: processed.rows.length }
}

/** 断点继续：补录井点后，只重跑失败与缺失井点行，已导入/已跳过的行不动。 */
export function resumeBatch(batchId: string): ImportBatch {
  const batches = listBatchesUncached()
  const index = batches.findIndex((batch) => batch.id === batchId)
  if (index < 0) {
    throw new Error(`没有找到批次 ${batchId}`)
  }
  const batch = batches[index]
  if (batch.state === 'confirmed') {
    throw new Error(`批次 ${batch.id} 已确认，不能再断点继续`)
  }

  // 已落库的新增行与命中的现场行建立索引，保证重跑仍然定位到同一目标。
  const currentRows = listRows(RECONCILE_MODULE_KEY)
  const existingMap = new Map<string, EntryRow>()
  for (const row of currentRows) {
    existingMap.set(`${String(row['井点编号'] ?? '')}__${String(row['观测日期'] ?? '')}`, row)
  }
  let cursor = nextRowId(currentRows)
  const ctx = {
    roster: rosterMap(),
    existing: existingMap,
    allocateId: () => cursor,
  }

  const rows = batch.rows.map((row) => {
    if (row.status !== 'failed' && row.status !== 'missing') {
      return row
    }
    const reprocessed = mergeRecord(
      {
        line: row.line,
        wellCode: row.wellCode,
        dateRaw: row.raw.dateRaw,
        depthText: row.raw.depthText,
        elevationText: row.raw.elevationText,
        waterTemp: row.raw.waterTemp,
        observer: row.raw.observer,
        raw: {},
      },
      ctx,
    )
    if (reprocessed.status === 'imported') {
      reprocessed.targetRowId = cursor
      cursor += 1
    }
    return reprocessed
  })
  const next = recount({ ...batch, rows })
  applyBatchRows(next)
  const nextBatches = [...batches]
  nextBatches[index] = next
  saveBatches(nextBatches)
  return { ...next }
}

/** 确认对账批次。多终端并发确认只生效一次，账本键与水质核查各自独立。 */
export function confirmBatch(batchId: string, operator: string): ImportBatch {
  const batches = listBatchesUncached()
  const index = batches.findIndex((batch) => batch.id === batchId)
  if (index < 0) {
    throw new Error(`没有找到批次 ${batchId}`)
  }
  if (batches[index].state === 'confirmed') {
    return { ...batches[index] }
  }
  if (batches[index].failed > 0 || batches[index].missing > 0) {
    throw new Error('批次仍有失败行或缺失井点，请先从断点继续处理完再确认')
  }
  const next: ImportBatch = {
    ...batches[index],
    state: 'confirmed',
    confirmedAt: new Date().toISOString(),
    confirmedBy: operator,
  }
  const nextBatches = [...batches]
  nextBatches[index] = next
  saveBatches(nextBatches)
  return { ...next }
}

export async function confirmBatchOnce(
  batchId: string,
  operator: string,
): Promise<{ applied: boolean; batch: ImportBatch }> {
  const outcome: OnceResult<ImportBatch> = await runOnce(
    `groundwater-confirm:${batchId}`,
    operator,
    () => confirmBatch(batchId, operator),
  )
  if (outcome.applied && outcome.result) {
    return { applied: true, batch: outcome.result }
  }
  const existing = getBatch(batchId)
  if (!existing) {
    throw new Error(`没有找到批次 ${batchId}`)
  }
  return { applied: false, batch: existing }
}

export function batchMissingWells(batchId: string) {
  const batch = getBatch(batchId)
  if (!batch) {
    return []
  }
  return missingWellsOf(batch)
}

export function resetReconcileData(): void {
  rosterCache = null
  batchesCache = null
  removeKey(ROSTER_KEY)
  removeKey(BATCHES_KEY)
  notifyRemoved(ROSTER_KEY)
  notifyRemoved(BATCHES_KEY)
  resetRows(RECONCILE_MODULE_KEY)
}

export { entriesStorageKey }
