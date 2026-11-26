import { expect, test } from '@playwright/test'
import JSZip from 'jszip'
import { makeEpub, PNG_1X1_B64 } from './epub-fixture'
import { registerFresh } from './fixtures'

async function variants() {
  const a = await makeEpub({ title: '同路径插图甲', imageName: 'shared.png', paragraphs: ['第一本正文。'] })
  const zip = await JSZip.loadAsync(a)
  const second = Buffer.concat([Buffer.from(PNG_1X1_B64, 'base64'), Buffer.from('different')])
  zip.file('OEBPS/images/shared.png', second)
  return { a, b: await zip.generateAsync({ type: 'nodebuffer' }), second }
}

test('同路径不同图的 EPUB 可导入，第一本显示和补传自己的图片', async ({ page }) => {
  await registerFresh(page)
  const { a, b } = await variants()
  const pick = async (buffer: Buffer, name: string) => {
    const response = page.waitForResponse(r => r.url().endsWith('/api/documents') && r.request().method() === 'POST')
    await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/epub+zip', buffer })
    const result = await response
    expect(result.status()).toBe(201)
    await expect(page.locator('.parse-bar')).toContainText('导入完成')
    return (await result.json()).docId as string
  }
  const id = await pick(a, 'a.epub')
  await pick(b, 'b.epub')
  await page.goto(`/read/${id}`)
  const img = page.locator('.figure-img').first()
  await img.scrollIntoViewIfNeeded()
  await expect(img).toBeVisible()
  const bytes = await img.evaluate(async el => Array.from(new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer())))
  expect(Buffer.from(bytes)).toEqual(Buffer.from(PNG_1X1_B64, 'base64'))
  const remote = await page.evaluate(async id => {
    const { api } = await import('/src/api/client.ts')
    const refs = (await api.getContent(id)).imageRefs
    const blob = await api.getImage(id, refs[0].imageId)
    return Array.from(new Uint8Array(await blob.arrayBuffer()))
  }, id)
  expect(Buffer.from(remote)).toEqual(Buffer.from(PNG_1X1_B64, 'base64'))
})

test('原文件上传失败明确回执并可补传', async ({ page }) => {
  await registerFresh(page)
  await page.route('**/api/documents/*/file', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, body: JSON.stringify({ code: 'HTTP_503', message: '暂时不可用' }) }) : route.continue())
  await page.locator('input[type=file]').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('可以阅读的正文。') })
  await expect(page.locator('.parse-bar')).toContainText('正文已导入，原文件上传失败')
  await page.unroute('**/api/documents/*/file')
  await page.getByRole('button', { name: '补传原文件', exact: true }).click()
  await expect(page.locator('.parse-bar')).toContainText('导入完成')
  await expect(page.locator('.book-card')).toHaveCount(1)
})

test('刷新网络失败保留令牌，联网后恢复登录', async ({ page }) => {
  await registerFresh(page)
  await page.route('**/api/auth/refresh', route => route.abort('internetdisconnected'))
  await page.reload()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('zhiyin.refreshToken'))).not.toBeNull()
  await page.unroute('**/api/auth/refresh')
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page).toHaveURL(/\/shelf/)
})

test('Markdown 同段重复图片都渲染，表格内容保留', async ({ page }) => {
  await registerFresh(page)
  await page.locator('input[type=file]').setInputFiles({ name: 'table.md', mimeType: 'text/markdown',
    buffer: Buffer.from('![甲](https://example.com/a.png) ![乙](https://example.com/a.png)\n\n| 名称 | 数量 |\n| --- | --- |\n| 保留下来的表格 | 12 |') })
  await expect(page.locator('.book-card')).toHaveCount(1)
  await page.locator('.book-card').click()
  await expect(page.locator('.doc-figure')).toHaveCount(2)
  await expect(page.locator('.reader-content')).toContainText('保留下来的表格 | 12')
})

test('图片缓存按服务器、账号、文档隔离，切换中的写入被拒绝', async ({ page }) => {
  await registerFresh(page)
  const result = await page.evaluate(async () => {
    const { authStore } = await import('/src/api/authStore.ts')
    const { setApiBase } = await import('/src/api/client.ts')
    const { imageScope, cacheGet, cachePut } = await import('/src/features/render/imageCache.ts')
    const user = authStore.userId
    const a = imageScope('one')
    await cachePut(a, 'same', new Blob(['first']))
    const otherDoc = await cacheGet(imageScope('two'), 'same')
    authStore.setUser('other-reader')
    const otherUser = await cacheGet(imageScope('one'), 'same')
    authStore.setUser(user)
    setApiBase('https://different.example/api')
    const otherServer = await cacheGet(imageScope('one'), 'same')
    const blocked = await cachePut(a, 'same', new Blob(['wrong'])).then(() => false, () => true)
    setApiBase(null)
    return { otherDoc, otherUser, otherServer, blocked, original: await (await cacheGet(imageScope('one'), 'same'))!.text() }
  })
  expect(result).toEqual({ otherDoc: null, otherUser: null, otherServer: null, blocked: true, original: 'first' })
})

test('旧书原文件恢复已污染的服务端图片，旧哈希仍去重且允许换插图', async ({ page }) => {
  await registerFresh(page)
  const { a, b, second } = await variants()
  const setup = await page.evaluate(async ({ bytes, wrong }) => {
    const { api } = await import('/src/api/client.ts')
    const { parseFile } = await import('/src/features/parse/index.ts')
    const parsed = await parseFile(new File([new Uint8Array(bytes)], 'old.epub'))
    const created = await api.importDocument({ ...parsed.payload, contentHash: parsed.legacyContentHash! })
    await api.putOriginalFile(created.docId, new Blob([new Uint8Array(bytes)]))
    await api.putImage(created.docId, parsed.payload.imageRefs[0].imageId, new Blob([new Uint8Array(wrong)], { type: 'image/png' }))
    return { id: created.docId, imageId: parsed.payload.imageRefs[0].imageId }
  }, { bytes: [...a], wrong: [...second] })
  await page.goto(`/read/${setup.id}`)
  const img = page.locator('.figure-img').first()
  await expect(img).toBeVisible()
  const remote = await page.evaluate(async ({ id, imageId }) => {
    const { api } = await import('/src/api/client.ts')
    // 等恢复补传结束后再核对服务端真值。
    return Array.from(new Uint8Array(await (await api.getImage(id, imageId)).arrayBuffer()))
  }, setup)
  expect(Buffer.from(remote)).toEqual(Buffer.from(PNG_1X1_B64, 'base64'))
  await page.goto('/shelf')
  await page.locator('input[type=file]').setInputFiles({ name: 'again.epub', mimeType: 'application/epub+zip', buffer: a })
  await expect(page.locator('.parse-bar')).toContainText('这本书已经在书架里了')
  await page.locator('input[type=file]').setInputFiles({ name: 'changed.epub', mimeType: 'application/epub+zip', buffer: b })
  await expect(page.locator('.parse-bar')).toContainText('导入完成')
  await expect(page.locator('.book-card')).toHaveCount(2)
})

test('刷新后资料接口临时失败保留新令牌，可重试恢复', async ({ page }) => {
  await registerFresh(page)
  await page.route('**/api/users/me', route => route.fulfill({ status: 503, body: '{}' }))
  await page.reload()
  await expect(page.getByRole('button', { name: '重试恢复登录' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('zhiyin.refreshToken'))).not.toBeNull()
  await page.unroute('**/api/users/me')
  await page.getByRole('button', { name: '重试恢复登录' }).click()
  await expect(page).toHaveURL(/\/shelf/)
})

test('旧图片缓存升级只丢弃无归属图片，保留音频与离线队列', async ({ page }) => {
  await page.route('**/cache-migration-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body>准备旧缓存</body></html>' }))
  await page.goto('/cache-migration-fixture')
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('zhiyin-cache', 5)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('images', { keyPath: 'imageId' })
        req.result.createObjectStore('audio', { keyPath: 'cacheKey' })
        req.result.createObjectStore('pending', { keyPath: 'id' })
      }
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const t = req.result.transaction(['images', 'audio', 'pending'], 'readwrite')
        t.objectStore('images').put({ imageId: 'old', blob: new Blob(['wrong']) })
        t.objectStore('audio').put({ cacheKey: 'keep-audio' })
        t.objectStore('pending').put({ id: 'keep-pending' })
        t.oncomplete = () => { req.result.close(); resolve() }
      }
    })
  })
  await registerFresh(page)
  const counts = await page.evaluate(async () => {
    const { openCacheDb } = await import('/src/features/cache/db.ts')
    const db = (await openCacheDb())!
    const count = (name: string) => new Promise<number>(resolve => {
      const req = db.transaction(name).objectStore(name).count()
      req.onsuccess = () => resolve(req.result)
    })
    return { images: await count('images'), audio: await count('audio'), pending: await count('pending') }
  })
  expect(counts).toEqual({ images: 0, audio: 1, pending: 1 })
})

test('原文件补传入口刷新后仍可用，匹配后不会重建文档', async ({ page }) => {
  await registerFresh(page)
  const file = { name: 'persist.txt', mimeType: 'text/plain', buffer: Buffer.from('需要补传的正文。') }
  await page.route('**/api/documents/*/file', route => route.fulfill({ status: 503, body: '{}' }))
  await page.locator('input[type=file]').setInputFiles(file)
  await expect(page.locator('.parse-bar')).toContainText('正文已导入，原文件上传失败')
  await page.unroute('**/api/documents/*/file')
  await page.reload()
  await expect(page.getByRole('button', { name: '选择原文件补传' })).toBeVisible()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择原文件补传' }).click()
  await (await chooser).setFiles(file)
  await expect(page.locator('.parse-bar')).toContainText('导入完成')
  await expect(page.locator('.book-card')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '选择原文件补传' })).toHaveCount(0)
})

test('禁用 IndexedDB 时仍从原 EPUB 显示并修复服务端错图', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }))
  await registerFresh(page)
  const { a, second } = await variants()
  const id = await page.evaluate(async ({ bytes, wrong }) => {
    const { api } = await import('/src/api/client.ts')
    const { parseFile } = await import('/src/features/parse/index.ts')
    const parsed = await parseFile(new File([new Uint8Array(bytes)], 'no-cache.epub'))
    const r = await api.importDocument(parsed.payload)
    await api.putOriginalFile(r.docId, new Blob([new Uint8Array(bytes)]))
    await api.putImage(r.docId, parsed.payload.imageRefs[0].imageId, new Blob([new Uint8Array(wrong)], { type: 'image/png' }))
    return r.docId
  }, { bytes: [...a], wrong: [...second] })
  await page.goto(`/read/${id}`)
  const img = page.locator('.figure-img').first()
  await expect(img).toBeVisible()
  const bytes = await img.evaluate(async el => Array.from(new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer())))
  expect(Buffer.from(bytes)).toEqual(Buffer.from(PNG_1X1_B64, 'base64'))
})

test('反复滚动同图只补传一次', async ({ page }) => {
  await registerFresh(page)
  const buffer = await makeEpub({ paragraphs: Array.from({ length: 60 }, (_, i) => `段落${i}的正文。`) })
  await page.locator('input[type=file]').setInputFiles({ name: 'scroll.epub', mimeType: 'application/epub+zip', buffer })
  await expect(page.locator('.parse-bar')).toContainText('导入完成')
  let uploads = 0
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/images/')) uploads++ })
  await page.locator('.book-card').click()
  const figure = page.locator('.doc-figure').first()
  await figure.scrollIntoViewIfNeeded()
  await expect(page.locator('.figure-img')).toBeVisible()
  await expect.poll(() => uploads).toBe(1)
  await page.evaluate(() => { document.querySelector('.reader-scroll')!.scrollTop = 0 })
  await expect(page.locator('.figure-img')).toHaveCount(0)
  await figure.scrollIntoViewIfNeeded()
  await expect(page.locator('.figure-img')).toBeVisible()
  // 等补传状态完成，避免在请求刚发起前作断言。
  await page.waitForTimeout(300)
  expect(uploads).toBe(1)
})

test('读取图片后 LRU 淘汰保留刚读过的图片', async ({ page }) => {
  await registerFresh(page)
  const kept = await page.evaluate(async () => {
    const { imageScope, cachePut, cacheEntry, cacheGet } = await import('/src/features/render/imageCache.ts')
    const { tx, STORE_IMAGES, evictByLru } = await import('/src/features/cache/db.ts')
    const scope = imageScope('lru-doc')
    for (const id of ['a', 'b', 'c']) await cachePut(scope, id, new Blob([id]))
    const rows = (await tx(STORE_IMAGES, 'readonly', s => s.getAll()))!
    for (let i = 0; i < rows.length; i++) await tx(STORE_IMAGES, 'readwrite', s => s.put({ ...rows[i], lastAccess: i + 1 }))
    await cacheEntry(scope, 'a')
    const touched = (await tx(STORE_IMAGES, 'readonly', s => s.getAll()))!
    await evictByLru(STORE_IMAGES, r => r.key, touched, 2, 10000)
    return { a: !!(await cacheGet(scope, 'a')), b: !!(await cacheGet(scope, 'b')), c: !!(await cacheGet(scope, 'c')) }
  })
  expect(kept).toEqual({ a: true, b: false, c: true })
})

test('无插图 EPUB 与旧 TXT 正文相同也不会被哈希迁移阻断', async ({ page }) => {
  await registerFresh(page)
  const zip = await JSZip.loadAsync(await makeEpub({ heading: '标题', paragraphs: ['正文。'] }))
  zip.file('OEBPS/ch1.xhtml', (await zip.file('OEBPS/ch1.xhtml')!.async('string')).replace(/<figure>.*?<\/figure>/s, ''))
  await page.locator('input[type=file]').setInputFiles({ name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('标题\n\n正文。') })
  await expect(page.locator('.parse-bar')).toContainText('导入完成')
  await page.locator('input[type=file]').setInputFiles({ name: 'same.epub', mimeType: 'application/epub+zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) })
  await expect(page.locator('.parse-bar')).toContainText('导入完成')
  await expect(page.locator('.book-card')).toHaveCount(2)
})

test('旧恢复请求的迟到 401 不清除刚手动登录的新凭据', async ({ page }) => {
  const account = await registerFresh(page)
  await page.route('**/api/users/me', route => route.fulfill({ status: 503, body: '{}' }))
  await page.reload()
  await expect(page.getByRole('button', { name: '重试恢复登录' })).toBeVisible()
  await page.unroute('**/api/users/me')
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/users/me', async route => {
    await barrier
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'AUTH_TOKEN_INVALID', message: '旧会话失效' }) })
  })
  const sent = page.waitForRequest(r => r.url().endsWith('/api/users/me'))
  await page.getByRole('button', { name: '重试恢复登录' }).click()
  await sent
  await page.locator('input[placeholder="手机号／邮箱"]').fill(account)
  await page.locator('input[type=password]').fill('e2e_password_123')
  await page.locator('form .btn-primary').click()
  await expect(page).toHaveURL(/\/shelf/)
  const token = await page.evaluate(() => localStorage.getItem('zhiyin.refreshToken'))
  const response = page.waitForResponse(r => r.url().endsWith('/api/users/me'))
  release()
  await response
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => localStorage.getItem('zhiyin.refreshToken'))).toBe(token)
})

test('旧哈希迁移拒绝与原正文不匹配的错误原文件', async ({ page }) => {
  await registerFresh(page)
  const { a } = await variants()
  const wrong = await makeEpub({ imageName: 'shared.png', paragraphs: ['完全不同的正文。'] })
  const result = await page.evaluate(async ({ bytes, wrong }) => {
    const { api } = await import('/src/api/client.ts')
    const { parseFile } = await import('/src/features/parse/index.ts')
    const { imageScope, cacheEntry } = await import('/src/features/render/imageCache.ts')
    const { migrateLegacyHash } = await import('/src/features/render/restoreImages.ts')
    const parsed = await parseFile(new File([new Uint8Array(bytes)], 'old.epub'))
    const r = await api.importDocument({ ...parsed.payload, contentHash: parsed.legacyContentHash! })
    await api.putOriginalFile(r.docId, new Blob([new Uint8Array(wrong)]))
    const rejected = await migrateLegacyHash(imageScope('import'), parsed.legacyContentHash).then(() => false, () => true)
    return { rejected, unchanged: (await api.getDocument(r.docId)).contentHash === parsed.legacyContentHash,
      cached: !!(await cacheEntry(imageScope(r.docId), parsed.payload.imageRefs[0].imageId)) }
  }, { bytes: [...a], wrong: [...wrong] })
  expect(result).toEqual({ rejected: true, unchanged: true, cached: false })
})

test('旧书原文件未保存时提示核验限制，并允许重新选择恢复', async ({ page }) => {
  await registerFresh(page)
  const { a, second } = await variants()
  const id = await page.evaluate(async ({ bytes, wrong }) => {
    const { api } = await import('/src/api/client.ts')
    const { parseFile } = await import('/src/features/parse/index.ts')
    const parsed = await parseFile(new File([new Uint8Array(bytes)], 'missing.epub'))
    const r = await api.importDocument({ ...parsed.payload, contentHash: parsed.legacyContentHash! })
    await api.putImage(r.docId, parsed.payload.imageRefs[0].imageId, new Blob([new Uint8Array(wrong)], { type: 'image/png' }))
    return r.docId
  }, { bytes: [...a], wrong: [...second] })
  await page.goto(`/read/${id}`)
  await expect(page.locator('.figure-missing-hint')).toContainText('无法核验插图')
  const uploaded = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/images/'))
  await page.locator('input[type=file]').setInputFiles({ name: 'missing.epub', mimeType: 'application/epub+zip', buffer: a })
  expect((await uploaded).status()).toBe(200)
  await expect(page.locator('.figure-missing-hint')).toHaveCount(0)
  const bytes = await page.locator('.figure-img').evaluate(async el => Array.from(new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer())))
  expect(Buffer.from(bytes)).toEqual(Buffer.from(PNG_1X1_B64, 'base64'))
})

test('超过图片缓存容量的 EPUB 仍能从原文件恢复当前视口图片', async ({ page }) => {
  await registerFresh(page)
  const { a, second } = await variants()
  const zip = await JSZip.loadAsync(a)
  const html = await zip.file('OEBPS/ch1.xhtml')!.async('string')
  const figure = html.match(/<figure>.*?<\/figure>/s)![0]
  zip.file('OEBPS/ch1.xhtml', html.replace(figure, figure.repeat(301)))
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const id = await page.evaluate(async ({ bytes, wrong }) => {
    const { api } = await import('/src/api/client.ts')
    const { parseFile } = await import('/src/features/parse/index.ts')
    const parsed = await parseFile(new File([new Uint8Array(bytes)], 'large.epub'))
    const r = await api.importDocument(parsed.payload)
    await api.putOriginalFile(r.docId, new Blob([new Uint8Array(bytes)]))
    await api.putImage(r.docId, parsed.payload.imageRefs[0].imageId, new Blob([new Uint8Array(wrong)], { type: 'image/png' }))
    return r.docId
  }, { bytes: [...buffer], wrong: [...second] })
  await page.goto(`/read/${id}`)
  const img = page.locator('.figure-img').first()
  await expect(img).toBeVisible({ timeout: 30000 })
  const bytes = await img.evaluate(async el => Array.from(new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer())))
  expect(Buffer.from(bytes)).toEqual(Buffer.from(PNG_1X1_B64, 'base64'))
})
