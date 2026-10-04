// 浏览器存储的薄封装：localStorage 不可用时（如 Node 自测）退化到内存 Map；
// 另外负责把其它标签页的 storage 事件分发给关心的模块，实现多终端联动刷新。

type Listener = (key: string, newValue: string | null) => void

const memory = new Map<string, string>()
const listeners = new Set<Listener>()

function hasNativeStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

export function readText(key: string, fallback = ''): string {
  if (hasNativeStorage()) {
    return window.localStorage.getItem(key) ?? fallback
  }
  return memory.has(key) ? (memory.get(key) as string) : fallback
}

export function writeText(key: string, value: string): void {
  if (hasNativeStorage()) {
    window.localStorage.setItem(key, value)
  } else {
    memory.set(key, value)
  }
}

export function removeKey(key: string): void {
  if (hasNativeStorage()) {
    window.localStorage.removeItem(key)
  } else {
    memory.delete(key)
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readText(key, '')
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(key: string, value: unknown): void {
  writeText(key, JSON.stringify(value))
  for (const listener of listeners) {
    listener(key, JSON.stringify(value))
  }
}

export function notifyRemoved(key: string): void {
  for (const listener of listeners) {
    listener(key, null)
  }
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (!event.key) {
      return
    }
    for (const listener of listeners) {
      listener(event.key, event.newValue)
    }
  })
}

export function subscribeStore(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
