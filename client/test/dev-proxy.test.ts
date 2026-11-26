import { afterEach, expect, it, vi } from 'vitest'
import { loadConfigFromFile } from 'vite'

afterEach(() => vi.unstubAllEnvs())
it('无代理覆盖时对接默认后端 3000，测试及自建端口仍可覆盖', async () => {
  vi.stubEnv('ZHIYIN_API_TARGET', '')
  const load = async () => (await loadConfigFromFile({ command: 'serve', mode: 'development' }))!.config.server!.proxy!['/api']
  expect(await load()).toMatchObject({ target: 'http://localhost:3000' })
  vi.stubEnv('ZHIYIN_API_TARGET', 'http://localhost:3333')
  expect(await load()).toMatchObject({ target: 'http://localhost:3333' })
})
