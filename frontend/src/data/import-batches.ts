// 对账批次的持久化：不加内存缓存，每次都直接读写 localStorage，
// 保证多个终端看到的是同一份批次状态（确认标志、断点位置都靠它同步）。
const BATCH_STORAGE_KEY = 'hydrology-monitor-station:import-batches'

export type FailedWellPoint = {
  rowNo: number
  wellNo: string
  reason: string
}

export type MissingWellPoint = {
  rowNo: number
  wellNo: string
  observeDate: string
  missingFields: string[]
  source: string
}

export type ImportBatch = {
  id: string
  module: string
  fileName: string
  fingerprint: string
  createdAt: string
  updatedAt: string
  totalRows: number
  wellCount: number
  imported: number
  complemented: number
  conflicts: number
  skipped: number
  failed: FailedWellPoint[]
  missing: MissingWellPoint[]
  confirmed: boolean
  followupDone: boolean
}

function readAll(): ImportBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(BATCH_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as ImportBatch[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeAll(batches: ImportBatch[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches))
  }
}

export function listBatches(moduleKey?: string): ImportBatch[] {
  const all = readAll()
  const matched = moduleKey ? all.filter((batch) => batch.module === moduleKey) : all
  return matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getBatch(id: string): ImportBatch | null {
  return readAll().find((batch) => batch.id === id) ?? null
}

export function findBatchByFingerprint(moduleKey: string, fingerprint: string): ImportBatch | null {
  return (
    readAll().find((batch) => batch.module === moduleKey && batch.fingerprint === fingerprint) ??
    null
  )
}

export function saveBatch(batch: ImportBatch): void {
  const all = readAll()
  const index = all.findIndex((item) => item.id === batch.id)
  if (index >= 0) {
    all[index] = batch
  } else {
    all.push(batch)
  }
  writeAll(all)
}

export function nextBatchId(moduleKey: string, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const prefix = `${moduleKey.toUpperCase()}-RECON-${day}-`
  const seq = readAll().filter((batch) => batch.id.startsWith(prefix)).length + 1
  return `${prefix}${String(seq).padStart(3, '0')}`
}
