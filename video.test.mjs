import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

/**
 * The video calculator is a separate page because it works the opposite way
 * round from the image one: it never derives the overall preference from the
 * rows. The rubric scores Overall first, as a gut call, and marks a row tally
 * wrong. These tests pin that down, because the whole point of the page is lost
 * if it ever starts computing a verdict.
 *
 * As with the image engine there is no module to import, so the engine is
 * lifted out of video.html between its markers and evaluated. video.html stays
 * the one source of truth.
 */
function loadVideo() {
  const html = fs.readFileSync(new URL('./video.html', import.meta.url), 'utf8')
  const startMarker = html.indexOf('---8<--- VIDEO START')
  const endMarker = html.indexOf('---8<--- VIDEO END')
  assert.ok(startMarker !== -1 && endMarker !== -1, 'video markers not found in video.html')
  const source = html.slice(html.indexOf('*/', startMarker) + 2, html.lastIndexOf('/*', endMarker))
  return new Function(
    source +
      '\n return { reviewVideo, buildVideoStarter, videoStarterAlternatives, beatSuggestion, paceNote, V_TASKS, V_AXES, V_NA, vOptionsFor }'
  )()
}

const video = loadVideo()

/** Score every row of a task the same way, then override individual rows. */
const fill = (taskId, value, over) =>
  Object.assign(
    video.V_TASKS[taskId].axes.reduce((acc, k) => Object.assign(acc, { [k]: value }), {}),
    over || {}
  )

const titles = (r) => r.flags.map((f) => f.title)

/* ---------------- the rule that makes this page different ---------------- */

test('the review never returns a computed verdict', () => {
  // The image engine returns result.verdict. This one must not.
  const r = video.reviewVideo('i2v', fill('i2v', 1))
  assert.equal(r.verdict, undefined)
  assert.equal(r.overall, 1)
})

test('the overall echoes what was picked, whatever the rows say', () => {
  // Every row sweeps to B and the rater picked A. The engine reports A, it does
  // not quietly correct it, because Overall is judged on its own merits.
  const r = video.reviewVideo('t2v', fill('t2v', -2, { overall: 2 }))
  assert.equal(r.overall, 2)
  assert.equal(r.tally.winsB, 5)
  assert.equal(r.tally.winsA, 0)
})

/* ---------------- shape of the forms ---------------- */

test('task shapes match the rubric', () => {
  assert.deepEqual(video.V_TASKS.t2v.axes, [
    'overall', 'instruction', 'visual', 'motion', 'audio', 'artifacts',
  ])
  // I2V adds the two preservation rows, R2V adds the human made row on top.
  assert.deepEqual(
    video.V_TASKS.i2v.axes.filter((k) => video.V_TASKS.t2v.axes.indexOf(k) === -1),
    ['personId', 'contentPres']
  )
  assert.deepEqual(
    video.V_TASKS.r2v.axes.filter((k) => video.V_TASKS.i2v.axes.indexOf(k) === -1),
    ['humanCreated']
  )
  // Overall comes first everywhere, because that is the order it is scored in.
  for (const id of Object.keys(video.V_TASKS)) {
    assert.equal(video.V_TASKS[id].axes[0], 'overall', `${id} must open on Overall`)
  }
})

test('N/A exists only on the two preservation rows', () => {
  const has = (k) => video.vOptionsFor(k).some((o) => o.value === video.V_NA)
  assert.equal(has('personId'), true)
  assert.equal(has('contentPres'), true)
  for (const k of ['overall', 'instruction', 'visual', 'motion', 'audio', 'artifacts', 'humanCreated']) {
    assert.equal(has(k), false, `${k} should not offer N/A`)
  }
})

test('every axis carries both severity definitions', () => {
  // Slightly against strongly is the call raters get wrong most, so no row may
  // ship without both halves of the split written out.
  for (const key of Object.keys(video.V_AXES)) {
    const a = video.V_AXES[key]
    assert.ok(a.slight && a.slight.length > 15, `${key} needs a slightly definition`)
    assert.ok(a.strong && a.strong.length > 15, `${key} needs a strongly definition`)
    assert.ok(a.blurb && a.blurb.length > 40, `${key} needs an explanation`)
  }
})

/* ---------------- calibration flags ---------------- */

test('tying every row is flagged as a stop', () => {
  const r = video.reviewVideo('t2v', fill('t2v', 0))
  const flag = r.flags.find((f) => f.title === 'Every single row is a tie')
  assert.ok(flag, `expected the all-tied flag, got ${titles(r)}`)
  assert.equal(flag.level, 'stop')
})

test('a clean sweep is flagged, a mixed win is not', () => {
  const sweep = video.reviewVideo('t2v', fill('t2v', 1))
  assert.ok(titles(sweep).includes('One side wins every row'))

  // One row goes the other way, so something is already said against the
  // winner and the flag would only be noise.
  const mixed = video.reviewVideo('t2v', fill('t2v', 1, { motion: -1 }))
  assert.ok(!titles(mixed).includes('One side wins every row'), titles(mixed).join(', '))
})

test('a sweep that loses the overall is not a sweep flag', () => {
  // Rows all favour A, rater picked B. That is the opposed case, not the
  // unexamined-winner case.
  const r = video.reviewVideo('t2v', fill('t2v', 1, { overall: -1 }))
  assert.ok(!titles(r).includes('One side wins every row'))
  assert.ok(titles(r).includes('Overall goes against every row that split'))
})

test('overall against every split row is flagged but allowed', () => {
  const r = video.reviewVideo('t2v', fill('t2v', -1, { overall: 2, visual: 0 }))
  const flag = r.flags.find((f) => f.title === 'Overall goes against every row that split')
  assert.ok(flag)
  // It is the documented exception, so it must not read as an error.
  assert.equal(flag.level, 'check')
  assert.match(flag.detail, /can be right/i)
})

test('a strong overall with no strong row is flagged', () => {
  const r = video.reviewVideo('t2v', fill('t2v', 1, { overall: 2 }))
  assert.ok(titles(r).includes('Strongly overall with no strong call anywhere below'))

  const withStrong = video.reviewVideo('t2v', fill('t2v', 1, { overall: 2, instruction: 2 }))
  assert.ok(!titles(withStrong).includes('Strongly overall with no strong call anywhere below'))
})

test('slight on everything is flagged as under-calling', () => {
  const r = video.reviewVideo('t2v', fill('t2v', 1))
  assert.ok(titles(r).includes('Every call you made is a slight'))
})

test('Human-Created contradicting AI tells is a stop', () => {
  const r = video.reviewVideo('r2v', fill('r2v', 1, { humanCreated: -1 }))
  const flag = r.flags.find((f) => f.title === 'Human-Created and Less AI Generated disagree')
  assert.ok(flag, titles(r).join(', '))
  assert.equal(flag.level, 'stop')

  // Agreeing, or either one tied, is fine.
  const agree = video.reviewVideo('r2v', fill('r2v', 1))
  assert.ok(!titles(agree).includes('Human-Created and Less AI Generated disagree'))
  const tied = video.reviewVideo('r2v', fill('r2v', 1, { humanCreated: 0 }))
  assert.ok(!titles(tied).includes('Human-Created and Less AI Generated disagree'))
})

test('the contradiction fires before the sheet is finished', () => {
  // Two rows are enough to know they disagree, so say so straight away rather
  // than after seven more rows have been filled in.
  const r = video.reviewVideo('r2v', { artifacts: 2, humanCreated: -2 })
  assert.equal(r.complete, false)
  assert.ok(titles(r).includes('Human-Created and Less AI Generated disagree'))
})

test('N/A raises a note about not dodging close calls', () => {
  const r = video.reviewVideo('i2v', fill('i2v', 1, { personId: video.V_NA }))
  const flag = r.flags.find((f) => f.title === 'Not applicable is in use')
  assert.ok(flag)
  assert.equal(flag.level, 'note')
})

test('an N/A row is excluded from the tally rather than counted as a tie', () => {
  const r = video.reviewVideo('i2v', fill('i2v', 1, { personId: video.V_NA }))
  // Seven rows besides overall, one of them N/A, so six judged and none tied.
  assert.equal(r.tally.judged, 6)
  assert.equal(r.tally.ties, 0)
  assert.equal(r.tally.winsA, 6)
})

test('flags are ordered worst first', () => {
  const r = video.reviewVideo('r2v', fill('r2v', 1, { humanCreated: -1, personId: video.V_NA }))
  const ranks = r.flags.map((f) => ({ stop: 0, check: 1, note: 2 })[f.level])
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b), 'flags must be sorted by severity')
})

test('a well balanced annotation raises nothing', () => {
  const r = video.reviewVideo('t2v', {
    overall: 1, instruction: 2, visual: 1, motion: -1, audio: 0, artifacts: 1,
  })
  assert.equal(r.complete, true)
  assert.deepEqual(r.flags, [], `unexpected flags: ${titles(r)}`)
})

/* ---------------- prompt beats ---------------- */

test('a fully missed beat points at a strong call', () => {
  const s = video.beatSuggestion([
    { text: 'she catches the ball', a: true, b: true },
    { text: 'she spikes it', a: true, b: false },
  ])
  assert.equal(s.value, 2, 'B missed a beat A delivered, so this points at Strongly A')
  assert.match(s.text, /strong call/i)

  const other = video.beatSuggestion([{ text: 'x', a: false, b: true }])
  assert.equal(other.value, -2)
})

test('equal beat misses do not separate the two', () => {
  const s = video.beatSuggestion([
    { text: 'a', a: false, b: true },
    { text: 'b', a: true, b: false },
  ])
  assert.equal(s.value, 0)
})

test('unchecked beats are ignored', () => {
  assert.equal(video.beatSuggestion([]), null)
  assert.equal(video.beatSuggestion([{ text: 'a', a: null, b: null }]), null)
  // A half ticked row cannot be judged, so it must not swing the count.
  const s = video.beatSuggestion([
    { text: 'a', a: true, b: true },
    { text: 'b', a: false, b: null },
  ])
  assert.equal(s.value, 0)
})

/* ---------------- pace ---------------- */

test('the pace note only fires when the work was rushed', () => {
  assert.equal(video.paceNote(600, 8), null)
  assert.equal(video.paceNote(5, 8), null, 'the clock has barely started')
  const rushed = video.paceNote(99, 8)
  assert.ok(rushed)
  assert.equal(rushed.level, 'check')
  // The threshold is ours rather than the client's, and the page must say so.
  assert.match(rushed.detail, /our own/i)
})

/* ---------------- justification skeleton ---------------- */

test('no skeleton until every row including overall is scored', () => {
  assert.equal(video.buildVideoStarter('i2v', {}), null)
  const missingOverall = fill('i2v', 1)
  delete missingOverall.overall
  assert.equal(video.buildVideoStarter('i2v', missingOverall), null)
})

test('the skeleton opens on the overall and covers every row', () => {
  const scores = fill('i2v', 1, { overall: 2, motion: 0, personId: video.V_NA })
  const text = video.buildVideoStarter('i2v', scores, 0)
  assert.match(text, /^I strongly prefer Response A overall/)
  // Lower cased, because a row that opens its own sentence is capitalised.
  const flat = text.toLowerCase()
  for (const phrase of [
    'instruction following', 'frame visual quality', 'motion and temporal quality',
    'audio quality and sync', 'ai tells', 'person id preservation', 'content preservation',
  ]) {
    assert.ok(flat.includes(phrase), `skeleton is missing ${phrase}`)
  }
  // The tied row asks what is shared, the N/A row asks why it does not apply.
  assert.match(text, /is even|are level|Neither clip gains/i)
  assert.match(text, /does not apply|out of scope/i)
})

test('the skeleton writes in the lines the flags ask for', () => {
  const sweep = video.buildVideoStarter('t2v', fill('t2v', 1), 0)
  assert.match(sweep, /wrong with the winner|Against A/i, 'a sweep must say something against the winner')

  const opposed = video.buildVideoStarter('t2v', fill('t2v', -1, { overall: 1 }), 0)
  assert.match(opposed, /goes against the rows|deliberate/i)
})

test('the skeleton names the trade-off when one exists', () => {
  const text = video.buildVideoStarter('t2v', fill('t2v', 1, { motion: -2 }), 0)
  assert.match(text, /Trade-off|Weighing it up|trade-off is/i)
  assert.ok(text.includes('motion and temporal quality'))
})

test('every bracket asks for evidence, never for a verdict', () => {
  const text = video.buildVideoStarter('i2v', fill('i2v', 1, { overall: 1, audio: 0 }), 3)
  const brackets = text.match(/\[[^\]]+\]/g) || []
  assert.ok(brackets.length >= 6, `expected a bracket per row, found ${brackets.length}`)
  for (const b of brackets) {
    assert.match(b, /say|name|quote|describe|state/i, `bracket gives no instruction: ${b}`)
  }
})

test('the skeleton clears the length floor reviewers apply', () => {
  for (const id of Object.keys(video.V_TASKS)) {
    const text = video.buildVideoStarter(id, fill(id, 1, { overall: 1 }), 0)
    assert.ok(text.split(/\s+/).length >= 20, `${id} skeleton is under 20 words`)
    assert.ok(text.length >= 100, `${id} skeleton is under 100 characters`)
  }
})

test('rewording changes the text but never the claims', () => {
  const scores = fill('i2v', 1, { overall: 1, motion: -2 })
  const seen = new Set()
  for (let seed = 0; seed < 12; seed++) {
    const text = video.buildVideoStarter('i2v', scores, seed)
    seen.add(text)
    // Motion went to B, so no wording may hand it to A.
    assert.ok(
      /On motion and temporal quality, B|B leads on motion and temporal quality|motion and temporal quality, B comes out ahead/.test(text),
      `seed ${seed} lost the motion claim: ${text}`
    )
  }
  assert.ok(seen.size >= 3, 'rewording should actually produce different text')
})

test('the alternatives bank offers a slot per row', () => {
  const scores = fill('r2v', 1, { overall: 1, audio: 0, personId: video.V_NA })
  const bank = video.videoStarterAlternatives('r2v', scores)
  assert.equal(bank.length, video.V_TASKS.r2v.axes.length, 'one slot per row, overall included')
  for (const group of bank) {
    assert.ok(group.options.length >= 2, `${group.slot} needs more than one wording`)
  }
})

test('no unfilled placeholder survives into the output', () => {
  for (const id of Object.keys(video.V_TASKS)) {
    for (const value of [2, 1, 0, -1, -2]) {
      const text = video.buildVideoStarter(id, fill(id, value), 5)
      assert.ok(!/\{\w+\}/.test(text), `${id} at ${value} left a placeholder: ${text}`)
    }
  }
})

test('the review survives every combination of scores', () => {
  // Brute force the smallest task, so a crash in a flag rule cannot hide behind
  // a combination nobody thought to try by hand.
  const vals = [2, 1, 0, -1, -2]
  const axes = video.V_TASKS.t2v.axes
  let count = 0
  const walk = (i, acc) => {
    if (i === axes.length) {
      const r = video.reviewVideo('t2v', acc)
      assert.equal(r.complete, true)
      assert.ok(Array.isArray(r.flags))
      assert.ok(!/\{\w+\}/.test(video.buildVideoStarter('t2v', acc, count)))
      count++
      return
    }
    for (const v of vals) walk(i + 1, Object.assign({}, acc, { [axes[i]]: v }))
  }
  walk(0, {})
  assert.equal(count, Math.pow(5, axes.length))
})

/* ---------------- house rules ---------------- */

test('no em dashes on the video page', () => {
  const html = fs.readFileSync(new URL('./video.html', import.meta.url), 'utf8')
  assert.equal(html.includes('—'), false, 'found an em dash in video.html')
})

test('no source URLs or company names leak into the video page', () => {
  const html = fs.readFileSync(new URL('./video.html', import.meta.url), 'utf8')
  for (const term of ['joinhandshake', 'hedgehog-faq', 'Handshake']) {
    assert.equal(html.includes(term), false, `video.html leaks "${term}"`)
  }
})

test('the build ships the video page', () => {
  const build = fs.readFileSync(new URL('./build.mjs', import.meta.url), 'utf8')
  assert.match(build, /PAGES\s*=\s*\[[^\]]*'video\.html'/, 'video.html is missing from the build list')
})
