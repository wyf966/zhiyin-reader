import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/api/client'
import { authStore } from '../src/api/authStore'

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) })
  authStore.set({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 1 })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); authStore.clear() })

it.each([0, 503, 429])('刷新临时失败 %s 保留令牌，网络恢复后可重试', async status => {
  vi.stubGlobal('fetch', async () => {
    if (!status) throw new TypeError('断网')
    return new Response('{}', { status })
  })
  await expect(api.silentLogin()).rejects.toThrow()
  expect(authStore.refresh).toBe('refresh')
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600 })))
  expect(await api.silentLogin()).toBe(true)
  expect(authStore.refresh).toBe('new-refresh')
})

it('刷新明确拒绝令牌时清理登录状态', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ code: 'AUTH_REFRESH_INVALID' }), { status: 401 }))
  expect(await api.silentLogin()).toBe(false)
  expect(authStore.refresh).toBeNull()
})

it('刷新超时保留令牌', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('超时', 'AbortError')))
  }))
  const result = api.silentLogin().catch(e => e)
  await vi.advanceTimersByTimeAsync(15001)
  expect(await result).toMatchObject({ code: 'TIMEOUT' })
  expect(authStore.refresh).toBe('refresh')
})
