// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import UpdateGate from '../src/features/app/UpdateGate'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const state = vi.hoisted(() => ({ min: 5, latest: 20, force: true }))
vi.mock('../src/api/platform', () => ({ isNativeApp: () => true }))
vi.mock('../src/api/appVersion', async original => ({
  ...await original<typeof import('../src/api/appVersion')>(), APP_VERSION_CODE: 10,
  fetchLatestVersion: async () => ({ minVersionCode: state.min, versionCode: state.latest,
    versionName: '2.0', force: state.force, apkUrl: '/download/app.apk' }),
}))

let cleanup = () => {}
afterEach(() => cleanup())
it.each([[5, true, false], [11, true, true], [0, true, false], [11, false, true]])(
  '最低版本 %s force %s 决定是否必须更新 %s', async (min, force, required) => {
    state.min = min
    state.force = force
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    await act(async () => root.render(createElement(UpdateGate, { children: '正文' })))
    cleanup = () => { act(() => root.unmount()); el.remove() }
    const dismiss = [...el.querySelectorAll('button')].find(b => b.textContent === '稍后更新')
    expect(!!dismiss).toBe(!required)
    if (dismiss) {
      act(() => dismiss.click())
      expect(el.querySelector('[role=dialog]')).toBeNull()
    } else expect(el.querySelector('[role=dialog]')).not.toBeNull()
  },
)
