import { expect, it } from 'vitest'
import { readingBoundaries } from '../src/readingBoundaries'

it.each([
  ['Asia/Shanghai', '2026-11-23T01:00:00Z', '2026-11-22T16:00:00.000Z', '2026-11-22T16:00:00.000Z'],
  ['America/New_York', '2026-03-09T12:00:00Z', '2026-03-09T04:00:00.000Z', '2026-03-09T04:00:00.000Z'],
  ['America/New_York', '2026-03-08T12:00:00Z', '2026-03-08T05:00:00.000Z', '2026-03-02T05:00:00.000Z'],
  ['America/New_York', '2026-11-01T12:00:00Z', '2026-11-01T04:00:00.000Z', '2026-10-26T04:00:00.000Z'],
])('日周边界 %s %s', (zone, now, today, week) => {
  expect(readingBoundaries(zone, new Date(now))).toEqual({ today, week })
})
