import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256Hex } from '../src/features/parse/sha256'

it('二进制摘要不经文本解码，包含无效 UTF-8 字节仍与标准 SHA256 一致', () => {
  const bytes = new Uint8Array([0, 255, 254, 0, 192, 128, 42])
  expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
})
