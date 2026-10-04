import {
  findBatchByFingerprint,
  getBatch,
  listBatches,
  nextBatchId,
  saveBatch,
  type FailedWellPoint,
  type ImportBatch,
  type MissingWellPoint,
} from '@/data/import-batches'
import { listRows, reloadFromStorage, saveRows } from '@/data/local-store'
import { withStorageLock } from '@/data/storage-lock'
import type { EntryRow } from '@/data/types'

// 地下水「井点编号资料对账包」：导入埋深值/水位标高、导出缺失井点、确认后联动水质核查。
// 约定：
// - 对账键是 井点编号 + 观测日期（日期先归一化再比较）；
// - 现场记录与文件冲突时以现场为准，文件值只补全现场空缺；
// - 同一文件（内容指纹相同）重复导入只形成一个批次，重导时只从失败井点断点继续；
// - 批次确认只生效一次：确认时修正存量缺失（标记异常值待补测），并在水质检测里生成一条核查记录。
const MODULE_KEY = 'groundwater'
const FOLLOWUP_MODULE_KEY = 'waterquality'
const LOCK_NAME = 'groundwater-recon'
const NUMERIC_FIELDS = ['埋深值', '水位标高'] as const

type ParsedRow = {
  rowNo: number
  wellNo: string
  observeDate: string
  depth: string
  elevation: string
}

export type ReconImportResult = {
  ok: boolean
  message: string
  resumed: boolean
  batch: ImportBatch | null
}

export type ReconConfirmResult = {
  ok: boolean
  message: string
  alreadyConfirmed: boolean
  staleFixed: number
  followupCreated: boolean
}

// 观测日期兼容：- / . 分隔、纯数字、中文「年月日」都认，统一落成 YYYY-MM-DD；认不出返回 null。
export function normalizeObserveDate(raw: string): string | null {
  const text = raw.trim()
  if (!text) {
    return null
  }
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  if (!match) {
    match = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(text)
  }
  if (!match) {
    match = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  }
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${year}-${pad(month)}-${pad(day)}`
}

function isNumericValue(raw: string): boolean {
  const text = raw.trim()
  return text !== '' && !Number.isNaN(Number(text))
}

// 文件内容指纹：同一文件重复导入靠它认出来，只形成一个批次。
export function fingerprint(content: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]
    if (quoted) {
      if (ch === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      cells.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  cells.push(current)
  return cells.map((cell) => cell.trim())
}

const COLUMN_ALIASES: Record<keyof Omit<ParsedRow, 'rowNo'>, string[]> = {
  wellNo: ['井点编号', '井点', '井号'],
  observeDate: ['观测日期', '观测时间', '日期'],
  depth: ['埋深值', '埋深'],
  elevation: ['水位标高', '标高'],
}

// 解析对账文件：先按表头别名找列，找不到表头就按 井点编号/观测日期/埋深值/水位标高 的顺序列处理。
export function parseReconFile(content: string): ParsedRow[] {
  const lines = content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
  if (!lines.length) {
    return []
  }
  const firstLine = splitCsvLine(lines[0])
  const indexOf = (aliases: string[]) => firstLine.findIndex((cell) => aliases.includes(cell))
  const hasHeader = indexOf(COLUMN_ALIASES.wellNo) >= 0
  const columnIndex = (key: keyof typeof COLUMN_ALIASES, fallback: number) => {
    if (!hasHeader) {
      return fallback
    }
    return indexOf(COLUMN_ALIASES[key])
  }
  const wellNoCol = columnIndex('wellNo', 0)
  const dateCol = columnIndex('observeDate', 1)
  const depthCol = columnIndex('depth', 2)
  const elevationCol = columnIndex('elevation', 3)
  const dataLines = hasHeader ? lines.slice(1) : lines
  const lineOffset = hasHeader ? 2 : 1
  const cellAt = (cells: string[], index: number) => (index >= 0 ? (cells[index] ?? '') : '')
  return dataLines.map((line, offset) => {
    const cells = splitCsvLine(line)
    return {
      rowNo: offset + lineOffset,
      wellNo: cellAt(cells, wellNoCol),
      observeDate: cellAt(cells, dateCol),
      depth: cellAt(cells, depthCol),
      elevation: cellAt(cells, elevationCol),
    }
  })
}

function nowText(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function todayText(now: Date): string {
  return nowText(now).slice(0, 10)
}

function newRecordCode(id: number): string {
  return `GROU-${String(id).padStart(4, '0')}`
}

function missingEntry(row: ParsedRow, date: string, fields: string[]): MissingWellPoint {
  return {
    rowNo: row.rowNo,
    wellNo: row.wellNo,
    observeDate: date,
    missingFields: fields,
    source: '对账文件',
  }
}

type RowOutcome =
  | { kind: 'failed'; failure: FailedWellPoint }
  | { kind: 'imported'; missing: MissingWellPoint[] }
  | { kind: 'complemented'; missing: MissingWellPoint[] }
  | { kind: 'conflict' }
  | { kind: 'skipped'; missing: MissingWellPoint[] }

// 单行对账：返回结果的同时把变更写进 rows（调用方统一落库）。
function applyRow(row: ParsedRow, rows: EntryRow[], nextId: { value: number }): RowOutcome {
  const wellNo = row.wellNo.trim()
  if (!wellNo) {
    return {
      kind: 'failed',
      failure: { rowNo: row.rowNo, wellNo: '—', reason: '井点编号为空' },
    }
  }
  const date = normalizeObserveDate(row.observeDate)
  if (!date) {
    return {
      kind: 'failed',
      failure: { rowNo: row.rowNo, wellNo, reason: `观测日期「${row.observeDate}」无法识别` },
    }
  }
  const values: Record<(typeof NUMERIC_FIELDS)[number], string> = {
    埋深值: row.depth.trim(),
    水位标高: row.elevation.trim(),
  }
  for (const field of NUMERIC_FIELDS) {
    const value = values[field]
    if (value !== '' && !isNumericValue(value)) {
      return {
        kind: 'failed',
        failure: { rowNo: row.rowNo, wellNo, reason: `${field}「${value}」不是数值` },
      }
    }
  }
  const fileMissing = NUMERIC_FIELDS.filter((field) => values[field] === '')
  const existingIndex = rows.findIndex(
    (entry) =>
      String(entry['井点编号'] ?? '').trim() === wellNo &&
      normalizeObserveDate(String(entry['观测日期'] ?? '')) === date,
  )
  if (existingIndex < 0) {
    const record: EntryRow = {
      id: nextId.value,
      status: '已采集',
      pending: true,
      abnormal: false,
      记录编号: newRecordCode(nextId.value),
      井点编号: wellNo,
      观测日期: date,
      埋深值: values['埋深值'],
      水位标高: values['水位标高'],
      水温: '',
      观测人: '对账导入',
      记录状态: '对账导入',
    }
    nextId.value += 1
    rows.push(record)
    return {
      kind: 'imported',
      missing: fileMissing.length ? [missingEntry(row, date, [...fileMissing])] : [],
    }
  }
  const existing = rows[existingIndex]
  const updated: EntryRow = { ...existing, 观测日期: date }
  let filled = 0
  let conflict = false
  const staleMissing: string[] = []
  for (const field of NUMERIC_FIELDS) {
    const current = String(existing[field] ?? '').trim()
    const incoming = values[field]
    if (!isNumericValue(current)) {
      // 存量缺失：文件有值就补全，文件也没有就记进缺失清单
      if (incoming !== '') {
        updated[field] = incoming
        filled += 1
      } else {
        staleMissing.push(field)
      }
    } else if (incoming !== '' && Number(incoming) !== Number(current)) {
      // 现场记录与文件冲突：以现场为准，不覆盖
      conflict = true
    }
  }
  rows[existingIndex] = updated
  const missing = staleMissing.length ? [missingEntry(row, date, staleMissing)] : []
  if (filled > 0) {
    return { kind: 'complemented', missing }
  }
  if (conflict) {
    return { kind: 'conflict' }
  }
  return { kind: 'skipped', missing }
}

function summarizeBatch(batch: ImportBatch, resumed: boolean): string {
  const parts = [
    `批次 ${batch.id}（共 ${batch.totalRows} 行）`,
    `新增 ${batch.imported}`,
    `补全存量 ${batch.complemented}`,
    `冲突保留现场 ${batch.conflicts}`,
    `无变化 ${batch.skipped}`,
    `失败 ${batch.failed.length}`,
    `缺失井点 ${batch.missing.length}`,
  ]
  return resumed
    ? `同一文件只形成一个批次，已从断点继续处理失败井点：${parts.join('，')}`
    : `对账包导入完成：${parts.join('，')}`
}

export async function importReconFile(
  fileName: string,
  content: string,
): Promise<ReconImportResult> {
  const parsed = parseReconFile(content)
  if (!parsed.length) {
    return { ok: false, message: '对账文件里没有可导入的数据行', resumed: false, batch: null }
  }
  const fileFingerprint = fingerprint(content)
  return withStorageLock(LOCK_NAME, () => {
    // 锁内先同步其他终端的最新数据，再判重、再落库
    reloadFromStorage()
    const rows = [...listRows(MODULE_KEY)]
    const nextId = { value: rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1 }
    const now = new Date()
    const existing = findBatchByFingerprint(MODULE_KEY, fileFingerprint)
    const resumed = existing !== null
    const batch: ImportBatch =
      existing ??
      ({
        id: nextBatchId(MODULE_KEY, now),
        module: MODULE_KEY,
        fileName,
        fingerprint: fileFingerprint,
        createdAt: nowText(now),
        updatedAt: nowText(now),
        totalRows: parsed.length,
        wellCount: 0,
        imported: 0,
        complemented: 0,
        conflicts: 0,
        skipped: 0,
        failed: [],
        missing: [],
        confirmed: false,
        followupDone: false,
      } satisfies ImportBatch)
    // 断点续传：同一文件重复导入时，只重试上次失败的行
    const retryRows = resumed ? new Set(batch.failed.map((item) => item.rowNo)) : null
    const targets = retryRows ? parsed.filter((row) => retryRows.has(row.rowNo)) : parsed
    const retriedRowNos = new Set(targets.map((row) => row.rowNo))
    const remainingFailed: FailedWellPoint[] = resumed
      ? batch.failed.filter((item) => !parsed.some((row) => row.rowNo === item.rowNo))
      : []
    const remainingMissing = resumed
      ? batch.missing.filter((item) => !retriedRowNos.has(item.rowNo))
      : []
    const wellNos = new Set<string>()
    for (const row of parsed) {
      if (row.wellNo.trim()) {
        wellNos.add(row.wellNo.trim())
      }
    }
    for (const row of targets) {
      const outcome = applyRow(row, rows, nextId)
      switch (outcome.kind) {
        case 'failed':
          remainingFailed.push(outcome.failure)
          break
        case 'imported':
          batch.imported += 1
          remainingMissing.push(...outcome.missing)
          break
        case 'complemented':
          batch.complemented += 1
          remainingMissing.push(...outcome.missing)
          break
        case 'conflict':
          batch.conflicts += 1
          break
        case 'skipped':
          batch.skipped += 1
          remainingMissing.push(...outcome.missing)
          break
      }
    }
    batch.failed = remainingFailed.sort((a, b) => a.rowNo - b.rowNo)
    batch.missing = remainingMissing
    batch.wellCount = wellNos.size
    batch.updatedAt = nowText(now)
    saveRows(MODULE_KEY, rows)
    saveBatch(batch)
    return { ok: true, message: summarizeBatch(batch, resumed), resumed, batch }
  })
}

// 批次确认：只生效一次。确认时修正存量缺失（标记异常值待补测），
// 并在水质检测模块生成一条核查记录；多终端并发确认由互斥锁 + confirmed 标志兜底。
export async function confirmReconBatch(batchId: string): Promise<ReconConfirmResult> {
  return withStorageLock(LOCK_NAME, () => {
    reloadFromStorage()
    const batch = getBatch(batchId)
    if (!batch) {
      return {
        ok: false,
        message: `没有找到批次 ${batchId}`,
        alreadyConfirmed: false,
        staleFixed: 0,
        followupCreated: false,
      }
    }
    if (batch.confirmed) {
      return {
        ok: true,
        message: `批次 ${batchId} 已确认过，并发重复处理只生效一次`,
        alreadyConfirmed: true,
        staleFixed: 0,
        followupCreated: false,
      }
    }
    // 存量缺失修正：仍缺埋深值/水位标高的记录标记为「异常值」，等待补测
    const rows = listRows(MODULE_KEY)
    let staleFixed = 0
    const fixedRows = rows.map((row) => {
      const missing = NUMERIC_FIELDS.filter((field) => !isNumericValue(String(row[field] ?? '')))
      if (!missing.length) {
        return row
      }
      staleFixed += 1
      return { ...row, status: '异常值', abnormal: true, pending: true }
    })
    saveRows(MODULE_KEY, fixedRows)
    // 联动：水质检测页面跟着新增一条核查记录
    const followupRows = [...listRows(FOLLOWUP_MODULE_KEY)]
    const followupId =
      followupRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const now = new Date()
    followupRows.push({
      id: followupId,
      status: '已采样',
      pending: true,
      abnormal: false,
      报告编号: `WATE-${String(followupId).padStart(4, '0')}`,
      采样站点: `地下水对账批次${batch.id}`,
      采样时间: todayText(now),
      检测项目: `井点水质核查（${batch.wellCount}处）`,
      检测值: '',
      标准上限: '',
      检测人: '对账联动',
      报告状态: '待核查',
    })
    saveRows(FOLLOWUP_MODULE_KEY, followupRows)
    saveBatch({ ...batch, confirmed: true, followupDone: true, updatedAt: nowText(now) })
    return {
      ok: true,
      message: `批次 ${batchId} 已确认：修正存量缺失 ${staleFixed} 条（标记异常值待补测），水质检测已新增核查记录`,
      alreadyConfirmed: false,
      staleFixed,
      followupCreated: true,
    }
  })
}

export function listReconBatches(): ImportBatch[] {
  return listBatches(MODULE_KEY)
}

type CsvFile = {
  filename: string
  content: string
}

function toCsv(filename: string, header: string[], lines: string[][]): CsvFile {
  const body = [header, ...lines].map((cells) => cells.join(',')).join('\n')
  return { filename, content: `\uFEFF${body}` }
}

// 缺失井点 = 各对账批次文件里缺值的（先与当前记录核对，已补全的不再算）+ 存量记录里仍缺值的，
// 按井点+日期+缺失项去重，文件来源优先展示。
export function exportMissingWellPoints(): CsvFile {
  reloadFromStorage()
  const rows = listRows(MODULE_KEY)
  const recordOf = (wellNo: string, observeDate: string) => {
    const date = normalizeObserveDate(observeDate) ?? observeDate.trim()
    return rows.find(
      (row) =>
        String(row['井点编号'] ?? '').trim() === wellNo.trim() &&
        (normalizeObserveDate(String(row['观测日期'] ?? '')) ?? '') === date,
    )
  }
  const stillMissing = (entry: MissingWellPoint) => {
    const record = recordOf(entry.wellNo, entry.observeDate)
    if (!record) {
      return true
    }
    return entry.missingFields.some((field) => !isNumericValue(String(record[field] ?? '')))
  }
  const entries: MissingWellPoint[] = []
  for (const batch of listBatches(MODULE_KEY)) {
    entries.push(...batch.missing.filter(stillMissing))
  }
  for (const row of rows) {
    const missing = NUMERIC_FIELDS.filter((field) => !isNumericValue(String(row[field] ?? '')))
    if (missing.length) {
      entries.push({
        rowNo: 0,
        wellNo: String(row['井点编号'] ?? ''),
        observeDate: normalizeObserveDate(String(row['观测日期'] ?? '')) ?? String(row['观测日期'] ?? ''),
        missingFields: [...missing],
        source: '存量记录',
      })
    }
  }
  const seen = new Set<string>()
  const lines: string[][] = []
  for (const entry of entries) {
    const fields = [...entry.missingFields].sort()
    const date = normalizeObserveDate(entry.observeDate) ?? entry.observeDate
    const key = `${entry.wellNo}|${date}|${fields.join('+')}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    lines.push([entry.wellNo, date, fields.join('、'), entry.source])
  }
  return toCsv('地下水缺失井点清单.csv', ['井点编号', '观测日期', '缺失项', '来源'], lines)
}

export function exportFailedWellPoints(batchId: string): CsvFile | null {
  const batch = getBatch(batchId)
  if (!batch) {
    return null
  }
  return toCsv(
    `对账批次${batch.id}-失败井点.csv`,
    ['文件行号', '井点编号', '失败原因'],
    batch.failed.map((item) => [String(item.rowNo), item.wellNo, item.reason]),
  )
}

export function downloadCsvFile(file: CsvFile): void {
  const blob = new Blob([file.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
