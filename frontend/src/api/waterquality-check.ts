import { listRows, saveRows } from '@/data/local-store'
import { readJson, writeJson } from '@/data/browser-store'
import { latestConfirmedBatch, rosterMap } from '@/data/reconcile-store'
import { currentTerminal, ledgerEntry, runOnce, subscribeStore, type LedgerEntry } from '@/data/once-ledger'
import type { EntryRow } from '@/data/types'

// 地下水对账批次确认后，水质检测页面跟着做一次「采样站点井点核查」：
// 逐份报告核对采样站点是否在已确认批次的井点台账内，并给出核查结果。
// 以已确认批次为幂等键：多个终端同时点核查只有一个终端真正生效。

const MODULE_KEY = 'waterquality'
const ledgerKeyFor = (batchId: string) => `waterquality-check:${batchId}`
const summaryKeyFor = (batchId: string) => `hydrology-monitor-station:waterquality-check-summary:${batchId}`

export type CheckSummary = {
  batchId: string
  checkedAt: string
  checkedBy: string
  terminal: string
  total: number
  matched: number
  unmatched: number
  unmatchedSites: string[]
}

export type PendingCheck = { canCheck: boolean; batchId: string | null; reason: string }

export function pendingCheck(): PendingCheck {
  const batch = latestConfirmedBatch()
  if (!batch) {
    return { canCheck: false, batchId: null, reason: '还没有已确认的地下水对账批次' }
  }
  const done = ledgerEntry(ledgerKeyFor(batch.id))
  if (done) {
    return {
      canCheck: false,
      batchId: batch.id,
      reason: `本批次核查已由终端 ${done.terminal.slice(0, 8)} 于 ${done.at.slice(0, 19).replace('T', ' ')} 完成`,
    }
  }
  return { canCheck: true, batchId: batch.id, reason: '' }
}

function performCheck(batchId: string, operator: string, terminal: string): CheckSummary {
  const roster = rosterMap()
  const waterRows = listRows(MODULE_KEY).map((row) => ({ ...row }))
  const unmatchedSites = new Set<string>()
  let matched = 0
  const nextRows = waterRows.map((row) => {
    const site = String(row['采样站点'] ?? '').trim()
    const ok = site.length > 0 && roster.has(site)
    if (ok) {
      matched += 1
    } else {
      unmatchedSites.add(site || '（空）')
    }
    return { ...row, 核查结果: ok ? `井点核对一致（批次 ${batchId}）` : `采样站点不在井点台账（批次 ${batchId}）` }
  })
  saveRows(MODULE_KEY, nextRows)

  const summary: CheckSummary = {
    batchId,
    checkedAt: new Date().toISOString(),
    checkedBy: operator,
    terminal,
    total: nextRows.length,
    matched,
    unmatched: unmatchedSites.size,
    unmatchedSites: [...unmatchedSites].sort(),
  }
  writeJson(summaryKeyFor(batchId), summary)
  return summary
}

export function readCheckSummary(batchId: string): CheckSummary | null {
  return readJson<CheckSummary | null>(summaryKeyFor(batchId), null)
}

export type CheckOutcome = {
  applied: boolean
  summary: CheckSummary | null
  entry: LedgerEntry
}

export async function runWaterQualityCheck(operator = '值班管理员'): Promise<CheckOutcome> {
  const pending = pendingCheck()
  if (!pending.batchId) {
    throw new Error(pending.reason)
  }
  const batchId = pending.batchId
  const outcome = await runOnce<CheckSummary>(
    ledgerKeyFor(batchId),
    `水质检测核查（对账批次 ${batchId}）`,
    () => performCheck(batchId, operator, currentTerminal()),
  )
  if (outcome.applied && outcome.result) {
    return { applied: true, summary: outcome.result, entry: outcome.entry }
  }
  return { applied: false, summary: null, entry: outcome.entry }
}

export function latestCheckEntry(): { entry: LedgerEntry; batchId: string } | null {
  const batch = latestConfirmedBatch()
  if (!batch) {
    return null
  }
  const entry = ledgerEntry(ledgerKeyFor(batch.id))
  return entry ? { entry, batchId: batch.id } : null
}

export { subscribeStore }
