import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

// app.js는 DOM에서 실행되는 일반 스크립트이므로 순수 배치 함수만 읽어 검증합니다.
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('function aspectOf('), source.indexOf('function layoutJustifiedAll('))
const { justifiedRows, justifiedHtml, aspectOf } = runInNewContext(`${functions}\n({ justifiedRows, justifiedHtml, aspectOf })`, {
  esc: (value) => String(value), photoAltText: () => '',
})
const photos = (ratios) => ratios.map((ratio) => ({ width: ratio * 1000, height: 1000, key_thumb: 'test' }))

test('mixed ratios, sparse groups and panoramas preserve order, bounds and width', () => {
  const sets = [[], [0.75], [0.75, 0.75], [1.5, 1.5, 1.5], [8, 0.75, 0.75, 1.5],
    Array.from({ length: 121 }, (_, i) => [0.4, 0.667, 0.75, 1, 1.5, 2, 3][i % 7])]
  for (const width of [280, 360, 390, 639, 640, 768, 1024, 1440]) {
    for (const gap of [8, 14]) {
      for (const ratios of sets) {
        const items = photos(ratios)
        const rows = justifiedRows(items, width, gap)
        const target = width < 640 ? 240 : 340
        let next = 0
        for (const row of rows) {
          assert.equal(row.start, next)
          assert.ok(row.end > row.start)
          assert.ok(row.height > 0 && row.height <= target * 1.15 + 1e-8)
          const sum = ratios.slice(row.start, row.end).reduce((a, b) => a + b, 0)
          assert.ok(sum * row.height + gap * (row.end - row.start - 1) <= width + 1e-8)
          if (row.height < target * 0.85 - 1e-8) {
            assert.equal(row.end - row.start, 1)
            assert.ok(width / ratios[row.start] < target * 0.85)
          }
          next = row.end
        }
        assert.equal(next, items.length)
        const html = justifiedHtml(items, 17, width, gap)
        assert.deepEqual([...html.matchAll(/data-i="(\d+)"/g)].map((m) => +m[1]), items.map((_, i) => i + 17))
      }
    }
  }
})

test('sparse rows stay at target height and invalid dimensions fall back safely', () => {
  assert.equal(justifiedRows(photos([0.75, 0.75]), 1200, 14)[0].height, 340)
  for (const item of [{}, { width: 10, height: 0 }, { width: -1, height: 3 }]) {
    assert.equal(aspectOf(item), 0.75)
  }
})

test('rebalances the tail instead of leaving one portrait on a separate row', () => {
  const rows = justifiedRows(photos([0.75, 0.75, 0.75, 0.75]), 900, 14)
  assert.deepEqual(Array.from(rows, (row) => row.end - row.start), [2, 2])
})
