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
  return new Function(
    source + '\n return { computeResult, TASKS, buildStarter, buildStarterVariants }'
  )()
}

const { computeResult, TASKS, buildStarter, buildStarterVariants } = loadEngine()

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

/* ---------------- open feedback starter ---------------- */

/** Every reachable R2I and T2I score combination. */
function* allCombos(taskId) {
  const axes = TASKS[taskId].axes
  const values = [2, 1, 0, -1, -2]
  const total = Math.pow(5, axes.length)
  for (let i = 0; i < total; i++) {
    const scores = {}
    let n = i
    for (const axis of axes) {
      scores[axis] = values[n % 5]
      n = Math.floor(n / 5)
    }
    yield scores
  }
}

test('starter is null until every axis is scored', () => {
  assert.equal(buildStarter({ instruction: 2 }, computeResult('r2i', { instruction: 2 })), null)
})

/** Any phrasing in the pool can be shown, so all of them must hold up. */
const TONES = ['neutral', 'conversational']

function eachVariant(fn) {
  for (const tone of TONES) {
    for (const taskId of ['r2i', 't2i']) {
      for (const scores of allCombos(taskId)) {
        const result = computeResult(taskId, scores)
        for (const text of buildStarterVariants(scores, result, tone)) {
          fn(text, result, scores, taskId, tone)
        }
      }
    }
  }
}

test('every phrasing stays within 150 to 200 characters', () => {
  eachVariant((text, _r, scores, taskId) => {
    assert.ok(
      text.length >= 150 && text.length <= 200,
      `${taskId} ${JSON.stringify(scores)} produced ${text.length} chars: ${text}`
    )
  })
})

test('no phrasing claims a sweep when the losing side won an axis', () => {
  const SWEEP =
    /does not win any dimension outright|does not take any dimension|does not come out ahead anywhere|Every dimension that separates|not win any of the remaining dimensions|only response to win a scored dimension|does not win anywhere/
  eachVariant((text, result, scores, taskId) => {
    if (!SWEEP.test(text)) return
    const loserWins = result.verdict.side === 'A' ? result.winsB : result.winsA
    assert.equal(loserWins, 0, `false sweep for ${taskId} ${JSON.stringify(scores)}: ${text}`)
  })
})

test('every phrasing names the side the engine actually picked', () => {
  eachVariant((text, result) => {
    if (result.verdict.side === 'T') {
      assert.doesNotMatch(text, /is preferred over Image/, `tie text picks a winner: ${text}`)
      return
    }
    const W = result.verdict.side
    const L = W === 'A' ? 'B' : 'A'
    assert.ok(
      text.includes('Image ' + W),
      `phrasing never names the winner ${W}: ${text}`
    )
    // The losing side must never be the one described as preferred.
    assert.doesNotMatch(
      text,
      new RegExp('Image ' + L + ' is (preferred|the stronger)'),
      `phrasing names the loser as preferred: ${text}`
    )
  })
})

test('every phrasing ends mid-sentence so it cannot pass as finished feedback', () => {
  eachVariant((text) => {
    assert.ok(text.endsWith(' '), `starter should trail a space: ${text}`)
    assert.doesNotMatch(text.trimEnd(), /[.!?]$/, `starter looks complete: ${text}`)
  })
})

test('every score set offers several different phrasings in both tones', () => {
  let min = Infinity
  for (const tone of TONES) {
    for (const taskId of ['r2i', 't2i']) {
    for (const scores of allCombos(taskId)) {
      const variants = buildStarterVariants(scores, computeResult(taskId, scores), tone)
      const unique = new Set(variants)
      assert.equal(unique.size, variants.length, `duplicate phrasings for ${JSON.stringify(scores)}`)
      min = Math.min(min, unique.size)
    }
    }
  }
  // Guards the point of the pool: identical openers across taskers is the
  // templated look the rating guidelines penalise.
  assert.ok(min >= 5, `some score set offers only ${min} phrasings`)
})

test('rewording changes the text and cycles back around', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const result = computeResult('r2i', scores)
  for (const tone of TONES) {
    const total = buildStarterVariants(scores, result, tone).length
    const seen = new Set()
    for (let seed = 0; seed < total; seed++) seen.add(buildStarter(scores, result, seed, tone))
    assert.equal(seen.size, total, `seeding should reach every ${tone} phrasing exactly once`)
  }
})

test('the two tones produce genuinely different wording', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const result = computeResult('r2i', scores)
  const neutral = new Set(buildStarterVariants(scores, result, 'neutral'))
  const casual = new Set(buildStarterVariants(scores, result, 'conversational'))
  const shared = [...casual].filter((s) => neutral.has(s))
  assert.ok(casual.size > 0 && neutral.size > 0)
  assert.ok(
    shared.length < Math.min(casual.size, neutral.size) / 2,
    'tones overlap too heavily to be distinguishable'
  )
})

test('an unknown tone falls back to neutral rather than emitting nothing', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const result = computeResult('r2i', scores)
  const fallback = buildStarterVariants(scores, result, 'nonsense')
  assert.deepEqual(fallback, buildStarterVariants(scores, result, 'neutral'))
})

test('no em dashes anywhere in the UI copy', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.equal(html.includes('—'), false, 'found an em dash in index.html')
})
