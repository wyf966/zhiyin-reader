import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { makeApp, closeApp, registerAndLogin, auth, importBody } from './helpers'

let app: FastifyInstance
beforeAll(async () => { app = await makeApp() })
afterAll(async () => { await closeApp(app) })
it('旧哈希查询按读者隔离，升级采用条件更新，升级后继续去重', async () => {
  const s = await registerAndLogin(app)
  const other = await registerAndLogin(app)
  const body = importBody({ contentHash: 'sha256:old', paragraphs: [{ text: '正文' }] })
  const id = (await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: body })).json().docId
  const lookup = (headers: Record<string, string>) => app.inject({ url: '/api/documents/by-hash?hash=sha256%3Aold', headers })
  expect((await lookup(auth(s))).json()).toEqual({ docId: id })
  expect((await lookup(auth(other))).json()).toBeNull()
  const patch = (headers: Record<string, string>) => app.inject({ method: 'PATCH', url: `/api/documents/${id}/content-hash`, headers, payload: { expectedHash: 'sha256:old', contentHash: 'sha256-v2:new' } })
  expect((await patch(auth(other))).statusCode).toBe(403)
  expect((await patch(auth(s))).statusCode).toBe(204)
  expect((await patch(auth(s))).statusCode).toBe(409)
  expect((await app.inject({ method: 'POST', url: '/api/documents', headers: auth(s), payload: { ...body, contentHash: 'sha256-v2:new' } })).statusCode).toBe(409)
})
