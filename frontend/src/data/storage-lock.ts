// 跨终端互斥锁：多个标签页/终端同时处理同一批业务时，只有一个能真正生效。
// 锁本体放在 localStorage 里，各终端共享；带过期时间，持有者崩了也不会死锁。
const LOCK_PREFIX = 'hydrology-monitor-station:lock:'
const LOCK_TTL_MS = 5000
const WAIT_TIMEOUT_MS = 10000

type LockHolder = {
  token: string
  expires: number
}

function readHolder(key: string): LockHolder | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as LockHolder
    if (typeof parsed.token !== 'string' || typeof parsed.expires !== 'number') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export async function withStorageLock<T>(name: string, task: () => T): Promise<T> {
  // 非浏览器环境（比如构建期）没有 localStorage，直接串行执行。
  if (typeof window === 'undefined' || !window.localStorage) {
    return task()
  }
  const key = `${LOCK_PREFIX}${name}`
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  for (;;) {
    const holder = readHolder(key)
    if (!holder || holder.expires <= Date.now()) {
      const next: LockHolder = { token, expires: Date.now() + LOCK_TTL_MS }
      window.localStorage.setItem(key, JSON.stringify(next))
      const current = readHolder(key)
      if (current?.token === token) {
        break
      }
    }
    if (Date.now() > deadline) {
      throw new Error('其他终端正在处理同一批数据，请稍后重试')
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 60 + Math.random() * 120)
    })
  }
  try {
    return task()
  } finally {
    const current = readHolder(key)
    if (current?.token === token) {
      window.localStorage.removeItem(key)
    }
  }
}
