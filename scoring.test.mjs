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
    source + '\n return { computeResult, TASKS, buildStarter, starterAlternatives, optionsFor, NA }'
  )()
}

const { computeResult, TASKS, buildStarter, starterAlternatives, optionsFor, NA } = loadEngine()

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

/** Walk every reachable score combination for a task. */
function eachCombo(fn) {
  for (const taskId of ['r2i', 't2i']) {
    for (const scores of allCombos(taskId)) {
      const result = computeResult(taskId, scores)
      fn(buildStarter(scores, result, 0), result, scores, taskId)
    }
  }
}

test('the skeleton is never short enough to be rejected', () => {
  // Reviewers reject one line answers under twenty words, so the scaffold must
  // start well clear of that even before the rater fills anything in.
  eachCombo((text, _r, scores, taskId) => {
    const words = text.trim().split(/\s+/).length
    assert.ok(words >= 40, `${taskId} ${JSON.stringify(scores)} produced only ${words} words`)
  })
})

test('every scored axis gets its own clause', () => {
  const NAMES = {
    instruction: 'instruction following',
    personId: 'person ID',
    refPreservation: 'reference preservation',
    visualQuality: 'visual quality',
    artifacts: 'AI artifacts',
  }
  eachCombo((text, _r, scores, taskId) => {
    for (const axis of TASKS[taskId].axes) {
      assert.ok(
        text.toLowerCase().includes(NAMES[axis].toLowerCase()),
        `${taskId} skeleton never mentions ${axis}: ${text}`
      )
    }
  })
})

test('a tied axis is described as not separating the two', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const text = buildStarter(scores, computeResult('r2i', scores), 0)
  assert.match(
    text,
    /reference preservation[^.]*(even|level|Neither)/i,
    'the tied axis should be called out as even'
  )
})

test('every skeleton states the trade-off', () => {
  // The reviewing standard names this as the most commonly missing part.
  eachCombo((text, _r, scores, taskId) => {
    assert.match(text, /Trade-off:/, `${taskId} ${JSON.stringify(scores)} has no trade-off line`)
  })
})

test('the skeleton opens on the side the engine actually picked', () => {
  eachCombo((text, result) => {
    if (result.verdict.side === 'T') {
      assert.doesNotMatch(text.split('.')[0], /prefer Response [AB]/, `tie text picks a winner: ${text}`)
      return
    }
    const W = result.verdict.side
    const L = W === 'A' ? 'B' : 'A'
    const opening = text.split('.')[0]
    assert.ok(
      opening.includes('Response ' + W),
      `opening does not name the winner ${W}: ${opening}`
    )
    assert.ok(
      !opening.includes('Response ' + L),
      `opening names the losing side ${L}: ${opening}`
    )
  })
})

test('brackets mark everything the rater must supply', () => {
  // The calculator cannot see the images, so any claim about them is a blank.
  eachCombo((text, _r, scores, taskId) => {
    const blanks = (text.match(/\[[^\]]+\]/g) || []).length
    assert.ok(blanks >= 2, `${taskId} ${JSON.stringify(scores)} left nothing for the rater: ${text}`)
  })
})

test('rewording changes the skeleton', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const result = computeResult('r2i', scores)
  const seen = new Set()
  for (let seed = 0; seed < 4; seed++) seen.add(buildStarter(scores, result, seed))
  assert.ok(seen.size >= 3, `rewording produced only ${seen.size} distinct skeletons`)
})

test('the rephrase bank offers several options per slot', () => {
  const scores = { instruction: 2, personId: 1, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const groups = starterAlternatives(scores, computeResult('r2i', scores))
  assert.ok(groups.length >= 4, 'expected a bank for opening, wins, evens and trade-off')
  for (const g of groups) {
    assert.ok(g.options.length >= 3, `${g.slot} offers only ${g.options.length} wordings`)
    assert.equal(new Set(g.options).size, g.options.length, `${g.slot} repeats a wording`)
  }
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

test('no source URLs or company names leak into the pages', () => {
  // The lesson text follows the source material, but the internal site address
  // and the company name must not appear on a public page.
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

test('results page question metadata matches the course, in order', () => {
  const html = fs.readFileSync(new URL('./results.html', import.meta.url), 'utf8')
  const s = html.indexOf('---8<--- META START')
  const e = html.indexOf('---8<--- META END')
  const source = html.slice(html.indexOf('*/', s) + 2, html.lastIndexOf('/*', e))
  const { QUESTION_META, QUESTION_LESSON } = new Function(
    source + '\n return { QUESTION_META, QUESTION_LESSON }'
  )()

  // The result code stores answers, retries and correctness positionally, so a
  // mismatch here would label one person's work with another question's text.
  assert.equal(QUESTION_META.length, course.ALL_QUESTIONS.length, 'question count differs')
  QUESTION_META.forEach((m, i) => {
    assert.equal(m.id, course.ALL_QUESTIONS[i].id, `question ${i} id differs between pages`)
    assert.equal(m.short, course.ALL_QUESTIONS[i].short, `question ${m.id} label differs`)
  })

  // Each question must map back to the lesson it actually belongs to.
  let k = 0
  course.LESSONS.forEach((lesson, li) => {
    lesson.questions.forEach(() => {
      assert.equal(QUESTION_LESSON[k], li, `question ${k} maps to the wrong lesson`)
      k++
    })
  })
})

test('every question carries a short label for the dashboard', () => {
  for (const q of course.ALL_QUESTIONS) {
    assert.ok(q.short && q.short.length > 5 && q.short.length < 45, `${q.id} needs a short label`)
  }
})

test('wrongTries counts picks made before the correct one', () => {
  const html = fs.readFileSync(new URL('./training.html', import.meta.url), 'utf8')
  const s = html.indexOf('---8<--- COURSE START')
  const e = html.indexOf('---8<--- COURSE END')
  const source = html.slice(html.indexOf('*/', s) + 2, html.lastIndexOf('/*', e))
  const { wrongTries, ALL_QUESTIONS } = new Function(
    source + '\n return { wrongTries, ALL_QUESTIONS }'
  )()

  const q = ALL_QUESTIONS[0]
  const right = q.answer
  const wrong1 = (right + 1) % q.options.length
  const wrong2 = (right + 2) % q.options.length

  assert.equal(wrongTries(q, {}), 0, 'never touched means no wrong tries')
  assert.equal(wrongTries(q, { [q.id]: [right] }), 0, 'straight to the answer is zero')
  assert.equal(wrongTries(q, { [q.id]: [wrong1, right] }), 1)
  assert.equal(wrongTries(q, { [q.id]: [wrong1, wrong2, right] }), 2)
  // Wandering away after being right does not add to the count.
  assert.equal(wrongTries(q, { [q.id]: [wrong1, right, wrong2] }), 1)
  // Never correct: every pick counts as a wrong one.
  assert.equal(wrongTries(q, { [q.id]: [wrong1, wrong2] }), 2)
})

/* ---------------- identity fingerprint ---------------- */

function extractIdentity(file) {
  const html = fs.readFileSync(new URL('./' + file, import.meta.url), 'utf8')
  const s = html.indexOf('---8<--- IDENTITY START')
  const e = html.indexOf('---8<--- IDENTITY END')
  assert.ok(s !== -1 && e !== -1, `identity markers not found in ${file}`)
  return html.slice(html.indexOf('*/', s) + 2, html.lastIndexOf('/*', e)).trim()
}

test('the fingerprint function is identical in both pages', () => {
  // If these drift, every submission verifies as WRONG and it looks like the
  // whole team cheated. That failure is silent and accusatory, so it fails here.
  assert.equal(
    extractIdentity('training.html'),
    extractIdentity('results.html'),
    'fingerprint() differs between training.html and results.html'
  )
})

test('fingerprints identify a person by their passphrase', () => {
  const { fingerprint } = new Function(
    extractIdentity('training.html') + '\n return { fingerprint }'
  )()

  // The same person with the same word always produces the same value.
  assert.equal(fingerprint('Daniel', 'otter'), fingerprint('Daniel', 'otter'))

  // A different passphrase does not verify as Daniel.
  assert.notEqual(fingerprint('Daniel', 'otter'), fingerprint('Daniel', 'badger'))

  // Nor does someone else using Daniel's word, since the name is mixed in.
  assert.notEqual(fingerprint('Daniel', 'otter'), fingerprint('Enny', 'otter'))

  // Case and stray spaces must not lock someone out of their own result.
  assert.equal(fingerprint('Daniel', 'otter'), fingerprint('daniel', '  OTTER '))

  // The output must be short enough to sit in a pasted code.
  assert.ok(fingerprint('Daniel', 'otter').length <= 12)
})

test('no passphrase list is present in any published page', () => {
  // The whole scheme rests on the pages containing no secrets to read.
  for (const f of ['training.html', 'results.html', 'index.html']) {
    const html = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8')
    assert.doesNotMatch(
      html,
      /hedgehog\.keys\s*=\s*\{[^}]*\w+\s*:\s*['"][^'"]+['"]/,
      `${f} appears to contain passphrase values`
    )
  }
})

/* ---------------- login and one attempt ---------------- */

test('keys.json covers the whole team and holds no plain passphrases', () => {
  const keys = JSON.parse(fs.readFileSync(new URL('./keys.json', import.meta.url), 'utf8'))
  const { fingerprint } = new Function(
    extractIdentity('training.html') + '\n return { fingerprint }'
  )()

  assert.deepEqual(Object.keys(keys).sort(), course.TEAM.slice().sort(), 'team mismatch')

  for (const [name, value] of Object.entries(keys)) {
    // A fingerprint, not a word: base36, and not equal to any plausible plain word.
    assert.match(value, /^[0-9a-z]{6,13}$/, `${name} value does not look like a fingerprint`)
    assert.notEqual(
      value,
      fingerprint(name, value),
      `${name} looks like the passphrase itself rather than its fingerprint`
    )
  }
})

test('config.json is present and parseable', () => {
  const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
  assert.ok('endpoint' in cfg, 'config.json needs an endpoint field, even if empty')
  assert.equal(typeof cfg.endpoint, 'string')
})

test('the training page no longer reveals answers before submission', () => {
  const html = fs.readFileSync(new URL('./training.html', import.meta.url), 'utf8')
  // Check answer used to reveal correctness mid-lesson. The lead sees the
  // answers instead, so nothing on the page should hand them back.
  assert.equal(html.includes('Check answer'), false, 'Check answer button still present')
  assert.equal(html.includes('Not quite, try again'), false, 'inline feedback still present')
})

test('the result carries what the dashboard needs to show their work', () => {
  const html = fs.readFileSync(new URL('./training.html', import.meta.url), 'utf8')
  for (const field of ['a:', 'w:', 'c:', 'ci:', 'k:', 'secs:']) {
    assert.ok(html.includes('              ' + field), `payload is missing ${field}`)
  }
})

test('the trainee result screen never reveals the answer key', () => {
  // One attempt each means the first person to finish could otherwise
  // screenshot every correct answer and hand it to everyone else.
  const html = fs.readFileSync(new URL('./training.html', import.meta.url), 'utf8')
  const app = html.slice(html.indexOf('function Results('), html.indexOf('function Shell('))
  assert.equal(app.includes('q.options[q.answer]'), false, 'shows the correct option')
  assert.equal(app.includes('{q.why}'), false, 'shows the explanation')
  assert.equal(app.includes('Answer:'), false, 'labels the correct answer')
})

/* ---------------- not applicable ---------------- */

test('N/A is offered on person ID and nowhere else', () => {
  const labels = (k) => optionsFor(k).map((o) => o.label)
  assert.ok(labels('personId').includes('N/A'), 'person ID should offer N/A')
  for (const k of ['instruction', 'refPreservation', 'visualQuality', 'artifacts']) {
    assert.ok(!labels(k).includes('N/A'), `${k} should not offer N/A`)
  }
})

test('N/A is excluded from the arithmetic rather than counted as zero', () => {
  const withNA = { instruction: 2, personId: NA, refPreservation: 1, visualQuality: 0, artifacts: 0 }
  const r = computeResult('r2i', withNA)

  // The classic bug here is string concatenation: 0 + 'na' yields "0na".
  assert.equal(typeof r.net, 'number', 'net must stay numeric with an N/A present')
  assert.equal(r.net, 3)
  assert.equal(r.winsA, 2)
  assert.equal(r.winsB, 0)
  assert.equal(r.verdict.label, 'Strongly A')
})

test('an N/A axis does not count towards a clean sweep', () => {
  // A wins the three judgeable axes and person ID does not apply, so this is a
  // sweep of everything that could be judged.
  const scores = { instruction: 1, personId: NA, refPreservation: 1, visualQuality: 1, artifacts: 0 }
  const r = computeResult('r2i', scores)
  assert.equal(r.winsA, 3)
  assert.equal(r.winsB, 0)
  assert.equal(r.verdict.label, 'Strongly A', 'net of +3 should still read as strong')
})

test('N/A and Tie produce different justification wording', () => {
  const base = { instruction: 2, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const tied = buildStarter({ ...base, personId: 0 }, computeResult('r2i', { ...base, personId: 0 }), 0)
  const na = buildStarter({ ...base, personId: NA }, computeResult('r2i', { ...base, personId: NA }), 0)

  assert.notEqual(tied, na, 'a tie and a not applicable must not read the same')
  assert.match(na, /person ID (does not apply|is out of scope)|no identity to preserve/i)
  // A tie asks for the shared detail; N/A must not, because there was nothing to compare.
  assert.doesNotMatch(
    na.split('.').find((l) => /person ID|identity/i.test(l)) || '',
    /shared detail/i,
    'N/A should not ask for a shared detail'
  )
})

test('the rephrase bank gains an N/A slot only when one is used', () => {
  const base = { instruction: 2, refPreservation: 0, visualQuality: -1, artifacts: -1 }
  const slots = (personId) => {
    const sc = { ...base, personId }
    return starterAlternatives(sc, computeResult('r2i', sc)).map((g) => g.slot)
  }
  assert.ok(slots(NA).some((s) => /does not apply/i.test(s)), 'expected an N/A slot')
  assert.ok(!slots(0).some((s) => /does not apply/i.test(s)), 'N/A slot should be absent on a tie')
})

test('every N/A combination still produces a usable skeleton', () => {
  const values = [2, 1, 0, -1, -2]
  for (const i of values) {
    for (const rp of values) {
      for (const vq of values) {
        const scores = { instruction: i, personId: NA, refPreservation: rp, visualQuality: vq, artifacts: 0 }
        const text = buildStarter(scores, computeResult('r2i', scores), 0)
        assert.ok(text.trim().split(/\s+/).length >= 40, `too short: ${text}`)
        assert.match(text, /Trade-off:/)
        assert.ok(!text.includes('undefined') && !text.includes('NaN'), `bad token in: ${text}`)
      }
    }
  }
})
