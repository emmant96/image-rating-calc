import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

/**
 * The app is a single index.html, so there is no module to import.
 * Instead we lift the scoring engine out of the file between its markers and
 * evaluate it. That keeps index.html the one and only source of truth: if the
 * logic in the page changes, these tests see the change.
 */
function loadEngine() {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  const startMarker = html.indexOf('---8<--- SCORING START')
  const endMarker = html.indexOf('---8<--- SCORING END')
  assert.ok(startMarker !== -1 && endMarker !== -1, 'scoring markers not found in index.html')
  // Trim to whole comment blocks so the extracted slice is valid JS on its own.
  const start = html.indexOf('*/', startMarker) + 2
  const end = html.lastIndexOf('/*', endMarker)
  const source = html.slice(start, end)
  return new Function(source + '\n return { computeResult, TASKS }')()
}

const { computeResult, TASKS } = loadEngine()

const r2i = ([instruction, personId, refPreservation, visualQuality, artifacts]) =>
  computeResult('r2i', { instruction, personId, refPreservation, visualQuality, artifacts })
const t2i = ([instruction, visualQuality, artifacts]) =>
  computeResult('t2i', { instruction, visualQuality, artifacts })

test('incomplete scoring yields no result', () => {
  assert.equal(computeResult('r2i', { instruction: 2 }), null)
  assert.equal(computeResult('t2i', { instruction: 2, visualQuality: 0 }), null)
})

test('R2I: more wins + net >= 3 => Strongly', () => {
  assert.equal(r2i([2, 2, 1, 0, 0]).verdict.label, 'Strongly A')
  assert.equal(r2i([-2, -2, -1, 0, 0]).verdict.label, 'Strongly B')
})

test('R2I: more wins + net of 1..2 => Slightly', () => {
  assert.equal(r2i([1, 1, 0, 0, 0]).verdict.label, 'Slightly A')
  assert.equal(r2i([1, 1, 1, -2, 0]).verdict.label, 'Slightly A') // 3 wins, net +1
  assert.equal(r2i([-1, -1, 0, 0, 0]).verdict.label, 'Slightly B')
})

test('R2I: 2-2-1 split defers to Instruction Following', () => {
  assert.equal(r2i([2, 1, -2, -1, 0]).verdict.label, 'Slightly A')
  assert.equal(r2i([-2, -1, 2, 1, 0]).verdict.label, 'Slightly B')
  assert.equal(r2i([0, 2, 1, -2, -1]).verdict.label, 'Tie')
})

test('R2I: all ties => Tie', () => {
  assert.equal(r2i([0, 0, 0, 0, 0]).verdict.label, 'Tie')
})

test('T2I: sweeping all 3 axes => Strongly', () => {
  assert.equal(t2i([1, 1, 1]).verdict.label, 'Strongly A')
  assert.equal(t2i([-1, -1, -1]).verdict.label, 'Strongly B')
})

test('T2I: 2 wins with |net| >= 3 => Strongly, else Slightly', () => {
  assert.equal(t2i([2, 1, 0]).verdict.label, 'Strongly A') // net +3
  assert.equal(t2i([1, 1, 0]).verdict.label, 'Slightly A') // net +2
  assert.equal(t2i([-2, -1, 0]).verdict.label, 'Strongly B')
})

test('T2I: single-axis win => Slightly', () => {
  assert.equal(t2i([2, 0, 0]).verdict.label, 'Slightly A')
  assert.equal(t2i([0, 0, -2]).verdict.label, 'Slightly B')
})

test('T2I: 1-1-1 split defers to Instruction Following', () => {
  assert.equal(t2i([2, 0, -2]).verdict.label, 'Slightly A')
  assert.equal(t2i([-2, 2, 0]).verdict.label, 'Slightly B')
  assert.equal(t2i([0, 2, -2]).verdict.label, 'Tie')
})

test('tallies and net are reported', () => {
  const r = r2i([2, 1, -1, 0, 0])
  assert.deepEqual({ winsA: r.winsA, winsB: r.winsB, net: r.net }, { winsA: 2, winsB: 1, net: 2 })
})

test('task axis counts match the spec', () => {
  assert.equal(TASKS.r2i.axes.length, 5)
  assert.equal(TASKS.t2i.axes.length, 3)
})

test('no em dashes anywhere in the UI copy', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.equal(html.includes('—'), false, 'found an em dash in index.html')
})
