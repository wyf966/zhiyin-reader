/** 日历边界按读者的 IANA 时区计算，周一为周首；不能用固定偏移代替夏令时。 */
export function readingBoundaries(timeZone: string, at = new Date()): { today: string; week: string } {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const localDate = (ms: number) => {
    const parts = format.formatToParts(ms)
    return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)!.value).join('-')
  }
  const today = localDate(at.getTime())
  const monday = new Date(`${today}T00:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7)
  const start = (date: string) => {
    const center = Date.parse(`${date}T00:00:00Z`)
    let low = center - 36 * 3600000
    let high = center + 36 * 3600000
    // 寻找当地日期开始的第一个毫秒，也能处理凌晨跳时的时区。
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (localDate(mid) < date) low = mid + 1
      else high = mid
    }
    return new Date(low).toISOString()
  }
  return { today: start(today), week: start(monday.toISOString().slice(0, 10)) }
}
