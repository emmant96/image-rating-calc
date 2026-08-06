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
function eachVariant(fn) {
  for (const taskId of ['r2i', 't2i']) {
    for (const scores of allCombos(taskId)) {
      const result = computeResult(taskId, scores)
      for (const text of buildStarterVariants(scores, result)) {
        fn(text, result, scores, taskId)
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

test('every score set offers several different phrasings', () => {
  let min = Infinity
  for (const taskId of ['r2i', 't2i']) {
    for (const scores of allCombos(taskId)) {
      const variants = buildStarterVariants(scores, computeResult(taskId, scores))
      const unique = new Set(variants)
      assert.equal(unique.size, variants.length, `duplicate phrasings for ${JSON.stringify(scores)}`)
      min = Math.min(min, unique.size)
    }
  }
  // Guards the point of the pool: identical openers across taskers is the
  // templated look the rating guidelines penalise.
  assert.ok(min >= 5, `some score set offers only ${min} phrasings`)
})

test('rewording changes the text and cycles back around', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const result = computeResult('r2i', scores)
  const total = buildStarterVariants(scores, result).length
  const seen = new Set()
  for (let seed = 0; seed < total; seed++) seen.add(buildStarter(scores, result, seed))
  assert.equal(seen.size, total, 'seeding should reach every phrasing exactly once')
})

test('no em dashes anywhere in the UI copy', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  assert.equal(html.includes('—'), false, 'found an em dash in index.html')
})

/* ---------------- training course ---------------- */

function loadCourse() {
  const html = fs.readFileSync(new URL('./training.html', import.meta.url), 'utf8')
  const s = html.indexOf('---8<--- COURSE START')
  const e = html.indexOf('---8<--- COURSE END')
  assert.ok(s !== -1 && e !== -1, 'course markers not found in training.html')
  const source = html.slice(html.indexOf('*/', s) + 2, html.lastIndexOf('/*', e))
  return new Function(
    source + '\n return { LESSONS, ALL_QUESTIONS, TEAM, estimateMinutes, scoreAnswers }'
  )()
}

const course = loadCourse()

test('every question has a valid answer index and an explanation', () => {
  for (const q of course.ALL_QUESTIONS) {
    assert.ok(q.options.length >= 2, `${q.id} needs at least two options`)
    assert.ok(
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length,
      `${q.id} answer index ${q.answer} is outside its options`
    )
    assert.ok(q.why && q.why.length > 30, `${q.id} needs an explanation`)
  }
})

test('question ids are unique', () => {
  const ids = course.ALL_QUESTIONS.map((q) => q.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate question id')
})

test('scoring counts only correct answers', () => {
  const perfect = {}
  course.ALL_QUESTIONS.forEach((q) => (perfect[q.id] = q.answer))
  assert.equal(course.scoreAnswers(perfect), course.ALL_QUESTIONS.length)

  const wrong = {}
  course.ALL_QUESTIONS.forEach((q) => (wrong[q.id] = (q.answer + 1) % q.options.length))
  assert.equal(course.scoreAnswers(wrong), 0)

  assert.equal(course.scoreAnswers({}), 0, 'unanswered must not score')
})

test('read estimates are sane', () => {
  for (const lesson of course.LESSONS) {
    const m = course.estimateMinutes(lesson)
    assert.ok(m >= 1 && m <= 15, `${lesson.id} estimated ${m} min, which looks wrong`)
  }
})

test('the whole team is listed', () => {
  assert.deepEqual(course.TEAM, ['Deborah', 'Radical', 'Keji', 'Enny', 'Daniel', 'Mimo', 'Onaope'])
})

test('results page lesson metadata matches the course', () => {
  const html = fs.readFileSync(new URL('./results.html', import.meta.url), 'utf8')
  const s = html.indexOf('---8<--- META START')
  const e = html.indexOf('---8<--- META END')
  assert.ok(s !== -1 && e !== -1, 'meta markers not found in results.html')
  const source = html.slice(html.indexOf('*/', s) + 2, html.lastIndexOf('/*', e))
  const { LESSON_META } = new Function(source + '\n return { LESSON_META }')()

  // The result code stores per lesson seconds positionally, so any drift here
  // would silently mislabel the columns on the dashboard.
  assert.equal(LESSON_META.length, course.LESSONS.length, 'lesson count differs between pages')
  LESSON_META.forEach((m, i) => {
    assert.equal(m.id, course.LESSONS[i].id, `lesson ${i} id differs between pages`)
    assert.equal(
      m.questions,
      course.LESSONS[i].questions.length,
      `lesson ${m.id} question count differs between pages`
    )
  })
})

test('no em dashes in the training or results pages', () => {
  for (const f of ['training.html', 'results.html']) {
    const html = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')
    assert.equal(html.includes('—'), false, `found an em dash in ${f}`)
  }
})

test('no client owned branding is republished', () => {
  // The course was rewritten precisely so none of this ends up on a public site.
  for (const f of ['training.html', 'results.html']) {
    const html = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')
    for (const term of ['joinhandshake', 'hedgehog-faq', 'Handshake']) {
      assert.equal(html.includes(term), false, `${f} leaks "${term}"`)
    }
  }
})

test('the correct answer is not always in the same position', () => {
  const positions = course.ALL_QUESTIONS.map((q) => q.answer)
  const spread = new Set(positions)
  assert.ok(
    spread.size >= 3,
    `answers only ever appear at position(s) ${[...spread].join(', ')}, which is guessable`
  )
  const atZero = positions.filter((p) => p === 0).length
  assert.ok(
    atZero <= positions.length / 2,
    `${atZero} of ${positions.length} answers sit at position 0`
  )
})
