import { readJson, subscribeStore, writeJson } from './browser-store'

// 「多个终端并发处理只生效一次」账本。
// 纯前端没有服务端事务，这里用 localStorage 的读-改-写做 CAS：
// 浏览器对同源 localStorage 的单次 setItem 是同步落盘的，两个标签页同时点击，
// 后执行的那个一定能读到先执行的写入，从而被账本挡下；
// 支持 navigator.locks 的浏览器再加一把跨标签页互斥锁兜底。
// 注意：换浏览器/清缓存属于不同存储域，那类「多终端」需要后端幂等表才能彻底防重。

const LEDGER_KEY = 'hydrology-monitor-station:once-ledger'

export type LedgerEntry = {
  key: string
  terminal: string
  at: string
  detail: string
}

export type OnceResult<T> = { applied: boolean; entry: LedgerEntry; result: T | null }

function loadLedger(): Record<string, LedgerEntry> {
  return readJson<Record<string, LedgerEntry>>(LEDGER_KEY, {})
}

function terminalId(): string {
  const key = 'hydrology-monitor-station:terminal-id'
  let value = readJson<string>(key, '')
  if (!value) {
    value =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    writeJson(key, value)
  }
  return value
}

export function currentTerminal(): string {
  return terminalId()
}

function claim(key: string, detail: string): LedgerEntry | null {
  const ledger = loadLedger()
  if (ledger[key]) {
    return null
  }
  const entry: LedgerEntry = { key, terminal: terminalId(), at: new Date().toISOString(), detail }
  ledger[key] = entry
  writeJson(LEDGER_KEY, ledger)
  // 写入后立即复读：同一事件循环里若有另一个同步写入抢先，复读结果会暴露冲突。
  const confirmed = loadLedger()[key]
  if (confirmed && confirmed.terminal !== entry.terminal) {
    return null
  }
  return confirmed ?? entry
}

function withBrowserLock<T>(key: string, work: () => T): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(key, work) as Promise<T>
  }
  return Promise.resolve(work())
}

/**
 * 幂等执行：同一 key 只允许第一个终端生效。
 * worker 不执行时直接返回账本里已有条目；work 抛错则不记账，允许重试。
 */
export async function runOnce<T>(
  key: string,
  detail: string,
  work: () => T,
): Promise<OnceResult<T>> {
  const existing = loadLedger()[key]
  if (existing) {
    return { applied: false, entry: existing, result: null }
  }
  return withBrowserLock(key, () => {
    const owned = claim(key, detail)
    if (!owned) {
      return { applied: false, entry: loadLedger()[key], result: null } as OnceResult<T>
    }
    try {
      const result = work()
      return { applied: true, entry: owned, result }
    } catch (error) {
      // 业务处理失败：只撤本终端自己记下的账，允许重试。
      const ledger = loadLedger()
      if (ledger[key]?.terminal === owned.terminal) {
        delete ledger[key]
        writeJson(LEDGER_KEY, ledger)
      }
      throw error
    }
  })
}

export function ledgerEntry(key: string): LedgerEntry | undefined {
  return loadLedger()[key]
}

export { subscribeStore }
