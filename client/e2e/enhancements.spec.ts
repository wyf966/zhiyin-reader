import { expect, test } from '@playwright/test'
import { loginAsDemo, openDemoBook, registerFresh } from './fixtures'

test.describe('产品与前端完善回归', () => {
  test('书内搜索：命中上下文展示、点击定位、上一处/下一处与快捷键', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    // 用快捷键 / 唤起书内搜索抽屉
    await page.keyboard.press('/')
    const panel = page.locator('.search-panel')
    await expect(panel).toBeVisible()

    const input = panel.locator('.search-input')
    await expect(input).toBeFocused()
    await input.fill('境界')

    const hits = panel.locator('.search-hit')
    const count = await hits.count()
    expect(count).toBeGreaterThan(1)
    await expect(panel.locator('.search-nav-bar')).toContainText(`第 1 / ${count} 处`)

    // 点下一处 & 上一处
    await panel.getByRole('button', { name: '下一处' }).click()
    await expect(panel.locator('.search-nav-bar')).toContainText(`第 2 / ${count} 处`)
    await expect(page.locator('.reader-content mark.search-mark-active').first()).toBeVisible()

    await panel.getByRole('button', { name: '上一处' }).click()
    await expect(panel.locator('.search-nav-bar')).toContainText(`第 1 / ${count} 处`)

    // Esc 关闭抽屉并归还焦点
    await page.keyboard.press('Escape')
    await expect(panel).toBeHidden()
  })

  test('播放条精简二级面板、从当前段开始、本机记住听书位置与键盘快捷键', async ({ page }) => {
    await loginAsDemo(page)
    await openDemoBook(page)

    const bar = page.locator('.playbar')
    // 键盘右方向键移动游标并记入本机听书记忆
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(bar.locator('.pb-counter')).toContainText('第 3 /')

    // 刷新页面后自动回到本机上次听到的第 3 句
    await page.reload()
    await expect(page.locator('.playbar .pb-counter')).toContainText('第 3 /')
    await expect(page.locator('.pb-memory-tag')).toContainText('已续上次')

    // 打开二级面板「声音与定时」：配置读完本章停止与定时停止
    await bar.getByRole('button', { name: /声音与定时/ }).click()
    const popover = bar.locator('.pb-popover')
    await expect(popover).toBeVisible()
    await popover.getByLabel('读完本章后自动停止').check()
    await expect(bar.locator('.pb-chip-timer')).toContainText('读完本章止')
    await popover.getByRole('button', { name: '15 分' }).click()
    await expect(bar.locator('.pb-chip-timer')).toContainText('剩余 15 分')
    await popover.getByRole('button', { name: '关闭' }).click()

    // 「从当前段开始」按钮可用
    await expect(bar.getByRole('button', { name: '从当前段开始' })).toBeEnabled()
  })

  test('真正的离线书单：下载本书、展示保存状态、断网刷新后仍可重新打开', async ({ page }) => {
    await registerFresh(page)
    const title = `离线测试书${Date.now()}`
    const txt = ['第一章 离线初卷', '', '断网之后依然可以安安静静读完这一段。', '', '第二章 离线续卷', '', '这是第二章的正文。'].join('\n')

    await page.locator('input[type="file"]').setInputFiles({
      name: `${title}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(txt, 'utf8'),
    })
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 20_000 })

    // 在书架卡片上点「下载离线」
    await page.locator('.book-card .book-offline-btn').click()
    await expect(page.locator('.book-card .book-offline-btn')).toContainText('已离线', { timeout: 15_000 })

    // 切到「离线文档」不再显示「这里恒为空」，而是展示正文与插图保存状态
    await page.locator('.shelf-side').getByText('离线文档', { exact: true }).click()
    await expect(page.locator('.book-card')).toHaveCount(1)
    await expect(page.locator('.offline-status-line')).toContainText('正文已保存')

    // 模拟后端/网络彻底断开：仅拦截 /api/ 接口请求（不拦 Vite 开发态的 /src/api/*.ts 模块）
    const isApiUrl = (url: URL) => url.pathname.startsWith('/api/')
    await page.route(isApiUrl, (route) => route.abort('internetdisconnected'))
    try {
      await page.reload()
      await expect(page.locator('.shelf-page')).toBeVisible({ timeout: 15_000 })
      await expect(page.locator('.parse-bar')).toContainText('离线模式')
      await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 15_000 })
      await page.locator('.book-card').first().click()
      await expect(page).toHaveURL(/\/read\//)
      await expect(page.locator('.offline-pill')).toContainText('离线副本')
      await expect(page.locator('.reader-content')).toContainText('断网之后依然可以安安静静读完这一段')
    } finally {
      await page.unroute(isApiUrl)
    }
  })

  test('划线、批注、书架「我的摘录」导出 Markdown 与顶部「继续阅读」横条', async ({ page }) => {
    await registerFresh(page)
    const title = `批注与续读${Date.now()}`
    const txt = [
      '第一章 缘起',
      '',
      '山高水长遇知音，这一句用来验证划词与批注持久化。',
      '',
      '第二章 远行',
      '',
      '清风徐来，水波不兴，翻到这里用来验证顶部继续阅读显示章名。',
    ].join('\n')

    await page.locator('input[type="file"]').setInputFiles({
      name: `${title}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(txt, 'utf8'),
    })
    await expect(page.locator('.book-card')).toHaveCount(1, { timeout: 20_000 })
    await page.locator('.book-card').first().click()
    await expect(page.locator('.sent').first()).toBeVisible({ timeout: 15_000 })

    // 在第一段正文内用 Range 选中文字并触发 mouseup 弹出划词条
    await page.evaluate(() => {
      const p = document.querySelector('p.doc-p')
      const textNode = p?.querySelector('.sent')?.firstChild
      if (!p || !textNode) return
      const range = document.createRange()
      range.setStart(textNode, 0)
      range.setEnd(textNode, 7)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })

    const selBar = page.locator('.sel-toolbar')
    await expect(selBar).toBeVisible()
    await selBar.getByRole('button', { name: '写批注' }).click()
    await selBar.locator('textarea').fill('这是一条端到端批注')
    await selBar.getByRole('button', { name: '保存批注' }).click()

    await expect(page.locator('.reader-content mark.hl-mark')).toHaveCount(1)

    // 刷新确认划线持久化，并在书签面板的「摘录」页签中可见
    await page.reload()
    await expect(page.locator('.reader-content mark.hl-mark')).toHaveCount(1)
    await page.locator('.reader-topbar').getByRole('button', { name: /书签/ }).click()
    await page.getByRole('tab', { name: /摘录/ }).click()
    await expect(page.locator('.ann-card')).toContainText('这是一条端到端批注')

    // 触发滚屏上报一次进度后回到书架
    await page.locator('.reader-scroll').evaluate((el) => {
      el.scrollTop = 200
      el.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(1800)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.locator('.shelf-page')).toBeVisible()

    // 书架顶部「继续阅读」横条显示书名与当前滚到的章名
    const hero = page.locator('.continue-card')
    await expect(hero).toBeVisible({ timeout: 10_000 })
    await expect(hero).toContainText(title)
    await expect(hero).toContainText('第二章 远行')

    // 切到「我的摘录」并测试导出 Markdown 下载
    await page.locator('.shelf-side').getByText('我的摘录', { exact: true }).click()
    await expect(page.locator('.marks-group')).toContainText(title)
    await expect(page.locator('.ann-note')).toContainText('这是一条端到端批注')

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出全部 Markdown' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toMatch(/\.md$/)
  })
})
