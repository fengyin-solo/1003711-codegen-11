import type { EntryRow } from './types'

// 井点编号资料对账包：纯函数领域层，不碰 localStorage，方便脱离浏览器自测。
// 业务规则：
// 1. 文件与现场存量记录冲突（同井点同日期、双方都有值且不一致）时以现场为准，文件值不覆盖；
// 2. 现场缺测的字段允许用文件补全；
// 3. 水位标高 = 地面高程 - 埋深值，两边都给了但对不上时标记存疑（abnormal）；
// 4. 井点编号不在台账里的行计入缺失井点，可导出清单、补录井点后从断点继续。

export const RECONCILE_MODULE_KEY = 'groundwater'

// 埋深与标高反算允许的闭合差（米），现场量测与高程起算面的常见容差取 0.06。
export const ELEVATION_TOLERANCE = 0.06

export type Well = {
  code: string
  name: string
  location: string
  groundElevation: number | null
  active: boolean
  addedAt: string | null
  source: string
}

export type ImportRowStatus = 'imported' | 'updated' | 'skipped' | 'failed' | 'missing'

export const IMPORT_ROW_STATUS_LABEL: Record<ImportRowStatus, string> = {
  imported: '新增导入',
  updated: '更新/补全',
  skipped: '跳过（以现场为准）',
  failed: '失败',
  missing: '缺失井点',
}

export type RowRawText = {
  dateRaw: string
  depthText: string
  elevationText: string
  waterTemp: string
  observer: string
}

export type BatchRow = {
  line: number
  wellCode: string
  dateRaw: string
  date: string | null
  depth: number | null
  elevation: number | null
  status: ImportRowStatus
  existingRowId: number | null
  targetRowId: number | null
  note: string
  changes: string[]
  inconsistent: boolean
  raw: RowRawText
}

export type BatchState = 'imported' | 'confirmed'

export type ImportBatch = {
  id: string
  fileName: string
  fileSize: number
  fileHash: string
  createdAt: string
  confirmedAt: string | null
  confirmedBy: string | null
  state: BatchState
  rows: BatchRow[]
  inserted: number
  updated: number
  skipped: number
  failed: number
  missing: number
}

export type ParsedRecord = {
  line: number
  wellCode: string
  dateRaw: string
  depthText: string
  elevationText: string
  waterTemp: string
  observer: string
  raw: Record<string, string>
}

export type MissingWell = {
  code: string
  times: number
  latestDate: string
  depths: string[]
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 观测日期兼容：把 2026.9.1 / 2026-09-01 / 20260902 / 9月5日 / Excel 序列值等统一成 YYYY-MM-DD。 */
export function normalizeDate(raw: string, fallbackYear: number = new Date().getFullYear()): string | null {
  const text = String(raw ?? '').trim()
  if (!text) {
    return null
  }
  // Excel 日期序列值：1899-12-30 起算的天数（5 位纯数字，且落在合理区间内才按序列值认）。
  if (/^\d{5}$/.test(text)) {
    const serial = Number(text)
    if (serial >= 20000 && serial <= 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000)
      return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
    }
    return null
  }
  // 先剥掉时间部分：2026-09-01 08:00、2026/9/1T8:00 都只取日期。
  const datePart = text.split(/[\sT]+/)[0]
  let m = datePart.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) {
    return formatDate(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  m = datePart.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) {
    return formatDate(Number(m[1]), Number(m[2]), Number(m[3]))
  }
  m = datePart.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/)
  if (m) {
    return formatDate(fallbackYear, Number(m[1]), Number(m[2]))
  }
  // 兜底交给原生解析（ISO 时间戳等），认不出来就返回 null 计入失败行。
  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) {
    return formatDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate())
  }
  return null
}

function formatDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 数值兼容：去掉空格、千分位、m/米 等单位后转数字。 */
export function normalizeNumber(raw: string): number | null {
  const text = String(raw ?? '').replace(/[\s,米m]/gi, '').trim()
  if (!text) {
    return null
  }
  const value = Number(text)
  return Number.isFinite(value) ? round2(value) : null
}

function detectDelimiter(headerLine: string): string {
  const candidates = ['\t', ',', ';', '，']
  let best = ','
  let bestCount = 0
  for (const delimiter of candidates) {
    const count = headerLine.split(delimiter).length - 1
    if (count > bestCount) {
      bestCount = count
      best = delimiter
    }
  }
  return best
}

function splitLine(line: string, delimiter: string): string[] {
  // 支持引号包裹的字段（字段里允许出现分隔符与双引号转义）。
  const cells: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      cells.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current.trim())
  return cells
}

/** 极简 CSV 解析：自动识别制表符/逗号/分号/中文逗号，返回二维单元格。 */
export function parseCsv(text: string): string[][] {
  const clean = String(text ?? '').replace(/^﻿/, '')
  const lines = clean
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    return []
  }
  const delimiter = detectDelimiter(lines[0])
  return lines.map((line) => splitLine(line, delimiter))
}

function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .trim()
    .replace(/[\s()（）]/g, '')
    .toLowerCase()
}

const HEADER_ALIASES: Record<string, string[]> = {
  wellCode: ['井点编号', '井编号', '井点', '观测井点', '井号', '机井编号'],
  date: ['观测日期', '日期', '观测时间', '测量日期', '监测日期'],
  depth: ['埋深值', '埋深', '地下水埋深', '埋深m', '埋深米', '地下水埋深m'],
  elevation: ['水位标高', '水位高程', '标高', '水位m', '水位米', '潜水位标高'],
  waterTemp: ['水温'],
  observer: ['观测人', '观测员', '记录人'],
}

function buildHeaderIndex(headerRow: string[]): Map<string, number> {
  const index = new Map<string, number>()
  headerRow.forEach((header, i) => {
    const key = normalizeHeader(header)
    if (key && !index.has(key)) {
      index.set(key, i)
    }
  })
  return index
}

function findColumn(index: Map<string, number>, aliases: string[]): number {
  for (const alias of aliases) {
    const hit = index.get(normalizeHeader(alias))
    if (hit !== undefined) {
      return hit
    }
  }
  return -1
}

function cell(cells: string[], index: number): string {
  return index >= 0 ? cells[index] ?? '' : ''
}

/** 解析导入文本：识别表头别名，逐行抽取井点编号/日期/埋深/标高。表头缺列直接报错。 */
export function parseImportText(text: string, fallbackYear?: number): ParsedRecord[] {
  const table = parseCsv(text)
  if (table.length < 2) {
    throw new Error('文件内容为空或只有表头，没有可导入的观测记录')
  }
  const headerIndex = buildHeaderIndex(table[0])
  const col = {
    wellCode: findColumn(headerIndex, HEADER_ALIASES.wellCode),
    date: findColumn(headerIndex, HEADER_ALIASES.date),
    depth: findColumn(headerIndex, HEADER_ALIASES.depth),
    elevation: findColumn(headerIndex, HEADER_ALIASES.elevation),
    waterTemp: findColumn(headerIndex, HEADER_ALIASES.waterTemp),
    observer: findColumn(headerIndex, HEADER_ALIASES.observer),
  }
  if (col.wellCode < 0 || col.date < 0) {
    throw new Error('文件表头缺少「井点编号」或「观测日期」列，请按模板整理后再导入')
  }
  const year = fallbackYear ?? new Date().getFullYear()
  const records: ParsedRecord[] = []
  table.slice(1).forEach((cells, i) => {
    const raw: Record<string, string> = {}
    table[0].forEach((header, h) => {
      if (header.trim()) {
        raw[header.trim()] = cells[h] ?? ''
      }
    })
    records.push({
      line: i + 2,
      wellCode: cell(cells, col.wellCode).trim(),
      dateRaw: cell(cells, col.date),
      depthText: cell(cells, col.depth),
      elevationText: cell(cells, col.elevation),
      waterTemp: cell(cells, col.waterTemp),
      observer: cell(cells, col.observer),
      raw,
    })
  })
  return records
}

/** 文件指纹：内容 hash（cyrb53）。同一内容改名上传仍视为同一文件，只形成一个批次。 */
export function hashContent(text: string): string {
  const source = String(text ?? '')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0')
}

export type MergeContext = {
  roster: Map<string, Well>
  existing: Map<string, EntryRow>
  allocateId: () => number
  fallbackYear?: number
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/**
 * 单行对账：返回批次行结果。
 * - 结构性问题（编号空/日期不认/数值非法/埋深为负）→ failed；
 * - 井点不在台账 → missing；
 * - 命中存量现场记录：冲突字段保留现场值（skipped 或仅补全差异字段）；
 * - 新井点日期：imported，缺一边时用地面高程反算补全。
 */
export function mergeRecord(rec: ParsedRecord, ctx: MergeContext): BatchRow {
  const year = ctx.fallbackYear ?? new Date().getFullYear()
  const base: BatchRow = {
    line: rec.line,
    wellCode: rec.wellCode,
    dateRaw: rec.dateRaw,
    date: null,
    depth: null,
    elevation: null,
    status: 'failed',
    existingRowId: null,
    targetRowId: null,
    note: '',
    changes: [],
    inconsistent: false,
    raw: {
      dateRaw: rec.dateRaw,
      depthText: rec.depthText,
      elevationText: rec.elevationText,
      waterTemp: rec.waterTemp,
      observer: rec.observer,
    },
  }
  const errors: string[] = []
  if (!rec.wellCode) {
    errors.push('井点编号为空')
  }
  const date = normalizeDate(rec.dateRaw, year)
  if (!date) {
    errors.push(`观测日期「${rec.dateRaw}」无法识别`)
  }
  base.date = date

  let depth = normalizeNumber(rec.depthText)
  let elevation = normalizeNumber(rec.elevationText)
  if (rec.depthText.trim() && depth === null) {
    errors.push(`埋深值「${rec.depthText.trim()}」不是数字`)
  }
  if (rec.elevationText.trim() && elevation === null) {
    errors.push(`水位标高「${rec.elevationText.trim()}」不是数字`)
  }
  if (depth !== null && depth < 0) {
    errors.push('埋深值不能为负数')
  }
  if (depth === null && elevation === null) {
    errors.push('埋深值与水位标高同时缺失，至少需要一项')
  }

  const well = rec.wellCode ? ctx.roster.get(rec.wellCode) : undefined
  if (rec.wellCode && !well) {
    // 结构性错误优先报失败；数据本身没问题才归入缺失井点。
    if (errors.length === 0) {
      base.status = 'missing'
      base.depth = depth
      base.elevation = elevation
      base.note = '井点编号不在资料台账，已列入缺失井点清单'
      return base
    }
    errors.push('井点编号不在资料台账')
  }

  if (errors.length > 0) {
    base.note = errors.join('；')
    return base
  }

  const ground = well?.groundElevation ?? null
  // 缺一边时用地面高程反算补全。
  if (depth === null && elevation !== null && ground !== null) {
    depth = round2(ground - elevation)
    base.changes.push('埋深值由地面高程与水位标高反算补全')
  }
  if (elevation === null && depth !== null && ground !== null) {
    elevation = round2(ground - depth)
    base.changes.push('水位标高由地面高程减埋深反算补全')
  }
  if (depth !== null && depth < 0) {
    base.note = '反算埋深为负数，地面高程或标高有误'
    return base
  }
  base.depth = depth
  base.elevation = elevation

  const key = `${rec.wellCode}__${date}`
  const existing = ctx.existing.get(key)
  if (existing) {
    base.existingRowId = Number(existing.id)
    const notes: string[] = []
    const fills: string[] = []
    const conflicts: string[] = []
    for (const field of ['埋深值', '水位标高'] as const) {
      const incoming = field === '埋深值' ? depth : elevation
      if (incoming === null) {
        continue
      }
      if (isBlank(existing[field])) {
        fills.push(`${field}：补 ${incoming}`)
      } else if (Number(existing[field]) !== incoming) {
        // 现场记录与文件冲突：以现场为准，文件值仅写入说明。
        conflicts.push(`${field}：现场 ${existing[field]} / 文件 ${incoming}`)
      }
    }
    if (!isBlank(rec.waterTemp) && isBlank(existing['水温'])) {
      fills.push(`水温：补 ${rec.waterTemp}`)
    }
    if (!isBlank(rec.observer) && isBlank(existing['观测人'])) {
      fills.push(`观测人：补 ${rec.observer}`)
    }
    if (fills.length > 0) {
      base.changes.push(...fills.map((item) => `存量补全 ${item}`))
    }
    if (conflicts.length > 0) {
      notes.push(`与现场记录冲突，按规则以现场为准（${conflicts.join('；')}）`)
    }
    // 闭合差只用现场实际值核算：有冲突时文件值未采用，不能拿文件值判现场存疑。
    const rawDepth = isBlank(existing['埋深值']) ? depth : Number(existing['埋深值'])
    const rawElevation = isBlank(existing['水位标高']) ? elevation : Number(existing['水位标高'])
    let inconsistent = false
    if (
      rawDepth !== null &&
      rawElevation !== null &&
      Number.isFinite(rawDepth) &&
      Number.isFinite(rawElevation) &&
      ground !== null
    ) {
      const closure = round2(ground - rawDepth - rawElevation)
      if (Math.abs(closure) > ELEVATION_TOLERANCE) {
        inconsistent = true
        base.changes.push(`现场埋深与标高闭合差 ${closure}m 超出 ±${ELEVATION_TOLERANCE}m，标记存疑`)
      }
    }
    base.inconsistent = inconsistent
    const changed = fills.length > 0 || inconsistent
    base.status = changed ? 'updated' : 'skipped'
    base.note = notes.join('；')
    return base
  }

  // 新增行：埋深与标高都给了且超出闭合差时标存疑（abnormal），数据照常入账由人工复核。
  if (depth !== null && elevation !== null && ground !== null) {
    const closure = round2(ground - depth - elevation)
    if (Math.abs(closure) > ELEVATION_TOLERANCE) {
      base.inconsistent = true
      base.changes.push(`埋深与标高闭合差 ${closure}m 超出 ±${ELEVATION_TOLERANCE}m，标记存疑`)
    }
  }

  base.status = 'imported'
  base.targetRowId = ctx.allocateId()
  return base
}

export function recount(batch: ImportBatch): ImportBatch {
  const next = { ...batch, rows: [...batch.rows] }
  next.inserted = next.rows.filter((row) => row.status === 'imported').length
  next.updated = next.rows.filter((row) => row.status === 'updated').length
  next.skipped = next.rows.filter((row) => row.status === 'skipped').length
  next.failed = next.rows.filter((row) => row.status === 'failed').length
  next.missing = next.rows.filter((row) => row.status === 'missing').length
  return next
}

/** 汇总批次里的缺失井点（同一井点出现多次合并成一行）。 */
export function missingWellsOf(batch: ImportBatch): MissingWell[] {
  const map = new Map<string, MissingWell>()
  for (const row of batch.rows.filter((item) => item.status === 'missing')) {
    const item = map.get(row.wellCode) ?? { code: row.wellCode, times: 0, latestDate: '', depths: [] }
    item.times += 1
    if (row.date && row.date > item.latestDate) {
      item.latestDate = row.date
    }
    const depthText = row.raw.depthText.trim()
    if (depthText && !item.depths.includes(depthText)) {
      item.depths.push(depthText)
    }
    map.set(row.wellCode, item)
  }
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code))
}

export function missingWellsCsv(wells: MissingWell[]): string {
  const header = ['井点编号', '出现次数', '最近观测日期', '文件埋深值']
  const lines = [header.join(',')]
  for (const well of wells) {
    lines.push([well.code, well.times, well.latestDate, well.depths.join('/')].join(','))
  }
  return `﻿${lines.join('\n')}`
}
