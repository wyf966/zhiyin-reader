import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { makeApp, closeApp, registerAndLogin, auth, importBody } from './helpers'
import { getDb } from '../src/db'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterEach(() => vi.useRealTimers())
afterAll(async () => { await closeApp(app) })

it('北京周一早晨的阅读计入今天和本周，周日只计入累计', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T01:00:00Z'))
  const s = await registerAndLogin(app)
  const docId = (await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: importBody({ paragraphs: [{ text: '正文' }] }) })).json().docId
  for (const startedAt of ['2026-11-22T22:00:00Z', '2026-11-22T15:00:00Z']) {
    expect((await app.inject({ method: 'POST', url: `/api/documents/${docId}/reading-time`, headers: auth(s), payload: {
      deviceId: 'dev', clientId: startedAt, durationMs: 60000, startedAt, endedAt: startedAt,
    } })).statusCode).toBe(200)
  }
  const summary = (await app.inject({ url: '/api/reading-time/summary?timeZone=Asia%2FShanghai', headers: auth(s) })).json()
  expect(summary).toMatchObject({ totalMs: 120000, todayMs: 60000, weekMs: 60000 })
  expect((await app.inject({ url: '/api/reading-time/summary?timeZone=bad', headers: auth(s) })).statusCode).toBe(400)
})

it('最近阅读按跨设备最新阅读记录排序并稳定分页', async () => {
  const s = await registerAndLogin(app)
  const ids: string[] = []
  for (let i = 0; i < 2; i++) {
    ids.push((await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: importBody({ paragraphs: [{ text: '正文' }] }) })).json().docId)
  }
  const db = getDb()
  ids.forEach((id, i) => db.prepare('UPDATE T_Document SET imported_at = ? WHERE doc_id = ?').run(`2026-11-${20 + i}T00:00:00Z`, id))
  for (const [index, device, at] of [[0, 'a', '2026-11-22'], [1, 'a', '2026-11-23'], [0, 'b', '2026-11-24']] as const) {
    db.prepare(`INSERT INTO T_ReadingProgress (progress_id, user_id, doc_id, device_id, updated_at, server_received_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(`${ids[index]}_${device}`, s.userId, ids[index], device, `${at}T00:00:00Z`, `${at}T00:00:00Z`)
  }
  const first = (await app.inject({ url: '/api/documents?category=recent&pageSize=1', headers: auth(s) })).json()
  expect(first.total).toBe(2)
  expect(first.items.map((r: { docId: string }) => r.docId)).toEqual([ids[0]])
})
