import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

/**
 * The image to video calculator is a separate page because it works the
 * opposite way round from the image one: it never derives the overall
 * preference from the rows. The rubric scores Overall first, as a gut call, and
 * marks a row tally wrong. These tests pin that down, because the whole point
 * of the page is lost if it ever starts computing a verdict.
 *
 * The second thing they pin down is length. The task is budgeted at ten minutes
 * and watching two clips properly takes five to six, so a skeleton that cannot
 * be filled in about four minutes is a broken skeleton however correct it is.
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
      '\n return { reviewVideo, buildVideoStarter, videoStarterAlternatives, skeletonCost, beatSuggestion, paceNote, TASK, AXES, NA, optionsFor, BUDGET_SECONDS }'
  )()
}

const video = loadVideo()

/** Score every row the same way, then override individual rows. */
const fill = (value, over) =>
  Object.assign(
    video.TASK.axes.reduce((acc, k) => Object.assign(acc, { [k]: value }), {}),
    over || {}
  )

const titles = (r) => r.flags.map((f) => f.title)

/* ---------------- the rule that makes this page different ---------------- */

test('the review never returns a computed verdict', () => {
  // The image engine returns result.verdict. This one must not.
  const r = video.reviewVideo(fill(1))
  assert.equal(r.verdict, undefined)
  assert.equal(r.overall, 1)
})

test('the overall echoes what was picked, whatever the rows say', () => {
  // Every row sweeps to B and the rater picked A. The engine reports A, it does
  // not quietly correct it, because Overall is judged on its own merits.
  const r = video.reviewVideo(fill(-2, { overall: 2 }))
  assert.equal(r.overall, 2)
  assert.equal(r.tally.winsB, 7)
  assert.equal(r.tally.winsA, 0)
})

/* ---------------- shape of the form ---------------- */

test('there is one task and it is image to video', () => {
  assert.equal(video.TASK.id, 'i2v')
  assert.deepEqual(video.TASK.axes, [
    'overall', 'instruction', 'visual', 'motion', 'audio', 'artifacts', 'personId', 'contentPres',
  ])
  // Overall comes first, because that is the order it is scored in.
  assert.equal(video.TASK.axes[0], 'overall')
})

test('the rows that belong to other video tasks are gone', () => {
  // The team only rates image to video. A stray Human-Created row, which is an
  // R2V form field, would just be one more thing to get wrong.
  assert.equal(video.AXES.humanCreated, undefined)
  assert.equal(video.TASK.axes.indexOf('humanCreated'), -1)
})

test('N/A exists only on the two preservation rows', () => {
  const has = (k) => video.optionsFor(k).some((o) => o.value === video.NA)
  assert.equal(has('personId'), true)
  assert.equal(has('contentPres'), true)
  for (const k of ['overall', 'instruction', 'visual', 'motion', 'audio', 'artifacts']) {
    assert.equal(has(k), false, `${k} should not offer N/A`)
  }
})

test('every axis carries both severity definitions', () => {
  // Slightly against strongly is the call raters get wrong most, so no row may
  // ship without both halves of the split written out.
  for (const key of Object.keys(video.AXES)) {
    const a = video.AXES[key]
    assert.ok(a.slight && a.slight.length > 15, `${key} needs a slightly definition`)
    assert.ok(a.strong && a.strong.length > 15, `${key} needs a strongly definition`)
    assert.ok(a.blurb && a.blurb.length > 40, `${key} needs an explanation`)
  }
})

/* ---------------- warnings ---------------- */

test('warnings are short enough to actually get read', () => {
  // A warning nobody reads inside a ten minute task is a warning that does not
  // exist. Titles are a glance, details are a couple of sentences.
  const seen = new Set()
  const collect = (scores) => video.reviewVideo(scores).flags.forEach((f) => seen.add(f))
  collect(fill(0))
  collect(fill(1))
  collect(fill(1, { overall: 2 }))
  collect(fill(-1, { overall: 1 }))
  collect(fill(1, { personId: video.NA }))
  collect(fill(0, { overall: 1, instruction: 1 }))
  assert.ok(seen.size >= 6, `expected most warnings to be reachable, saw ${seen.size}`)
  for (const f of seen) {
    assert.ok(f.title.length <= 48, `title too long to glance at: ${f.title}`)
    assert.ok(f.detail.length <= 320, `detail too long to read mid task: ${f.title}`)
  }
})

test('warnings are written in plain words', () => {
  // The team has to understand these at speed, so the jargon that crept into
  // the first version is kept out by test rather than by good intentions.
  const banned = /\b(annotation|calibration|dimension|rubric|axis|axes|heuristic)\b/i
  const scores = [fill(0), fill(1), fill(1, { overall: 2 }), fill(-1, { overall: 1 }), fill(1, { personId: video.NA })]
  for (const s of scores) {
    for (const f of video.reviewVideo(s).flags) {
      assert.doesNotMatch(f.title, banned, `jargon in title: ${f.title}`)
      assert.doesNotMatch(f.detail, banned, `jargon in detail of "${f.title}": ${f.detail}`)
    }
  }
})

test('tying every row is flagged as a stop', () => {
  const r = video.reviewVideo(fill(0))
  const flag = r.flags.find((f) => f.title === 'You tied everything')
  assert.ok(flag, `expected the all-tied flag, got ${titles(r)}`)
  assert.equal(flag.level, 'stop')
})

test('a clean sweep is flagged, a mixed win is not', () => {
  const sweep = video.reviewVideo(fill(1))
  assert.ok(titles(sweep).includes('One video won every single row'))

  // One row goes the other way, so something is already said against the
  // winner and the warning would only be noise.
  const mixed = video.reviewVideo(fill(1, { motion: -1 }))
  assert.ok(!titles(mixed).includes('One video won every single row'), titles(mixed).join(', '))
})

test('a sweep that loses the overall is not a sweep warning', () => {
  // Rows all favour A, rater picked B. That is the opposed case, not the
  // unexamined-winner case.
  const r = video.reviewVideo(fill(1, { overall: -1 }))
  assert.ok(!titles(r).includes('One video won every single row'))
  assert.ok(titles(r).includes('Your overall pick lost every row'))
})

test('an overall that lost every row is flagged but allowed', () => {
  const r = video.reviewVideo(fill(-1, { overall: 2, visual: 0 }))
  const flag = r.flags.find((f) => f.title === 'Your overall pick lost every row')
  assert.ok(flag)
  // It is the documented exception, so it must not read as an error.
  assert.equal(flag.level, 'check')
  assert.match(flag.detail, /allowed/i)
})

test('a strong overall with no strong row is flagged', () => {
  const r = video.reviewVideo(fill(1, { overall: 2 }))
  assert.ok(titles(r).includes('You said Strongly, but nothing below is strong'))

  const withStrong = video.reviewVideo(fill(1, { overall: 2, instruction: 2 }))
  assert.ok(!titles(withStrong).includes('You said Strongly, but nothing below is strong'))
})

test('slight on everything is flagged as under-calling', () => {
  const r = video.reviewVideo(fill(1))
  assert.ok(titles(r).includes('Every call you made is a small one'))
})

test('N/A raises a note about not dodging close calls', () => {
  const r = video.reviewVideo(fill(1, { personId: video.NA }))
  const flag = r.flags.find((f) => f.title === 'You used N/A')
  assert.ok(flag)
  assert.equal(flag.level, 'note')
})

test('N/A fires before the sheet is finished', () => {
  // Whether the row exists at all does not depend on the other rows, so say so
  // straight away rather than at the end.
  const r = video.reviewVideo({ personId: video.NA })
  assert.equal(r.complete, false)
  assert.ok(titles(r).includes('You used N/A'))
})

test('an N/A row is excluded from the tally rather than counted as a tie', () => {
  const r = video.reviewVideo(fill(1, { personId: video.NA }))
  // Seven rows besides overall, one of them N/A, so six judged and none tied.
  assert.equal(r.tally.judged, 6)
  assert.equal(r.tally.ties, 0)
  assert.equal(r.tally.winsA, 6)
})

test('warnings are ordered worst first', () => {
  const r = video.reviewVideo(fill(0, { overall: 0, personId: video.NA }))
  const ranks = r.flags.map((f) => ({ stop: 0, check: 1, note: 2 })[f.level])
  assert.deepEqual(ranks, ranks.slice().sort((a, b) => a - b), 'warnings must be sorted by severity')
})

test('a well balanced sheet raises nothing', () => {
  const r = video.reviewVideo({
    overall: 1, instruction: 2, visual: 1, motion: -1, audio: 0, artifacts: 1, personId: 1, contentPres: 0,
  })
  assert.equal(r.complete, true)
  assert.deepEqual(r.flags, [], `unexpected warnings: ${titles(r)}`)
})

/* ---------------- prompt beats ---------------- */

test('a fully missed beat points at a strong call', () => {
  const s = video.beatSuggestion([
    { text: 'she catches the ball', a: true, b: true },
    { text: 'she spikes it', a: true, b: false },
  ])
  assert.equal(s.value, 2, 'B missed a beat A delivered, so this points at Strongly A')
  assert.match(s.text, /big miss/i)

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

/* ---------------- the ten minute budget ---------------- */

test('the budget is ten minutes', () => {
  assert.equal(video.BUDGET_SECONDS, 600)
})

test('the pace note fires at both ends and stays quiet in between', () => {
  assert.equal(video.paceNote(5), null, 'the clock has barely started')
  const rushed = video.paceNote(99)
  assert.ok(rushed)
  assert.equal(rushed.level, 'check')
  // The floor is ours, not the client's, and the page has to say so.
  assert.match(rushed.detail, /our own/i)

  assert.equal(video.paceNote(360), null, 'six minutes in is exactly on plan')

  const late = video.paceNote(560)
  assert.ok(late, 'approaching ten minutes should say so')
  assert.equal(late.level, 'note')
})

/* ---------------- justification skeleton ---------------- */

test('no skeleton until every row including overall is scored', () => {
  assert.equal(video.buildVideoStarter({}), null)
  const missingOverall = fill(1)
  delete missingOverall.overall
  assert.equal(video.buildVideoStarter(missingOverall), null)
})

test('the skeleton fits what four minutes of writing can carry', () => {
  // A realistic sheet: a couple of rows separate the clips, the rest do not.
  const realistic = {
    overall: 1, instruction: 1, visual: 0, motion: -1, audio: 0, artifacts: 0,
    personId: video.NA, contentPres: 1,
  }
  const cost = video.skeletonCost(video.buildVideoStarter(realistic, 0))
  assert.ok(cost.blanks <= 7, `${cost.blanks} blanks is more than four minutes of typing`)
  assert.ok(cost.words >= 45, `${cost.words} words would be rejected as too thin`)
  assert.ok(cost.words <= 130, `${cost.words} words is more than the task has time for`)
  assert.equal(cost.roomy, true)
})

test('rows that decided nothing do not each get their own sentence', () => {
  // Four even rows must cost one line between them, not four.
  const scores = {
    overall: 1, instruction: 1, visual: 0, motion: 0, audio: 0, artifacts: 0, personId: 1, contentPres: 1,
  }
  const text = video.buildVideoStarter(scores, 0)
  const sentences = text.split('. ').length
  assert.ok(sentences <= 6, `${sentences} sentences for three split rows is too many`)
  // All four even rows are still named, in one line.
  for (const name of ['frame visual quality', 'motion and temporal quality', 'audio quality and sync', 'AI tells']) {
    assert.ok(text.includes(name), `the even line dropped ${name}`)
  }
})

test('the not applicable rows are named once, not argued row by row', () => {
  const scores = {
    overall: -1, instruction: -1, visual: -1, motion: 0, audio: 0, artifacts: 0,
    personId: video.NA, contentPres: video.NA,
  }
  const text = video.buildVideoStarter(scores, 0)
  assert.match(text, /person ID preservation and content preservation/i)
  assert.equal((text.match(/Not applicable|does not apply/gi) || []).length, 1)
})

test('every row that split gets its own line with its own evidence', () => {
  const scores = {
    overall: 1, instruction: 1, visual: 0, motion: -2, audio: 0, artifacts: 0, personId: 0, contentPres: 0,
  }
  const text = video.buildVideoStarter(scores, 0)
  assert.match(text, /instruction following, A|A leads on instruction following|A is ahead on instruction following/)
  assert.match(text, /motion and temporal quality, B|B leads on motion and temporal quality|B is ahead on motion and temporal quality/)
})

test('the skeleton opens on the overall', () => {
  const text = video.buildVideoStarter(fill(1, { overall: 2 }), 0)
  assert.match(text, /^I strongly prefer Response A/)
  const slight = video.buildVideoStarter(fill(1), 0)
  assert.match(slight, /^I slightly prefer Response A/)
})

test('the skeleton writes in the lines the warnings ask for', () => {
  const sweep = video.buildVideoStarter(fill(1), 0)
  assert.match(sweep, /Against A|What is wrong with A/i, 'a sweep must say something against the winner')

  const opposed = video.buildVideoStarter(fill(-1, { overall: 1 }), 0)
  assert.match(opposed, /rows lean to B|against the rows on purpose/i)
})

test('the skeleton names the trade-off when one exists', () => {
  const text = video.buildVideoStarter(fill(1, { motion: -2 }), 0)
  assert.match(text, /Trade-off|B wins/i)
  assert.ok(text.includes('motion and temporal quality'))
})

test('every blank asks for evidence, never for a verdict', () => {
  const text = video.buildVideoStarter(fill(1, { overall: 1, audio: 0 }), 3)
  const blanks = text.match(/\[[^\]]+\]/g) || []
  assert.ok(blanks.length >= 3, `expected several blanks, found ${blanks.length}`)
  for (const b of blanks) {
    assert.match(b, /say|name|quote|describe|state/i, `blank gives no instruction: ${b}`)
  }
})

test('the skeleton clears the length floor reviewers apply', () => {
  // Under twenty words is rejected outright, whatever the scores were.
  for (const value of [2, 1, 0, -1, -2]) {
    const text = video.buildVideoStarter(fill(value), 0)
    assert.ok(text.split(/\s+/).length >= 20, `a sheet of all ${value} produced under 20 words`)
  }
})

test('rewording changes the text but never the claims', () => {
  const scores = fill(1, { overall: 1, motion: -2 })
  const seen = new Set()
  for (let seed = 0; seed < 12; seed++) {
    const text = video.buildVideoStarter(scores, seed)
    seen.add(text)
    // Motion went to B, so no wording may hand it to A.
    assert.ok(
      /On motion and temporal quality, B|B leads on motion and temporal quality|B is ahead on motion and temporal quality/.test(text),
      `seed ${seed} lost the motion claim: ${text}`
    )
  }
  assert.ok(seen.size >= 3, 'rewording should actually produce different text')
})

test('the alternatives bank covers the overall and each split row', () => {
  const scores = {
    overall: 1, instruction: 1, visual: 0, motion: -1, audio: 0, artifacts: 0,
    personId: video.NA, contentPres: 0,
  }
  const bank = video.videoStarterAlternatives(scores)
  const slots = bank.map((g) => g.slot)
  assert.ok(slots.includes('Overall'))
  assert.ok(slots.includes('Instruction Following'))
  assert.ok(slots.includes('Motion and Temporal Quality'))
  assert.ok(slots.includes('The even rows'))
  assert.ok(slots.includes('Not applicable'))
  // A row that decided nothing has no line of its own, so it has no slot either.
  assert.ok(!slots.includes('Audio Quality and Sync'))
  for (const group of bank) {
    assert.ok(group.options.length >= 2, `${group.slot} needs more than one wording`)
  }
})

test('the cost readout counts blanks and estimates the finished length', () => {
  const cost = video.skeletonCost('One [say a thing] and two [name a thing].')
  assert.equal(cost.blanks, 2)
  // Three real words, the trailing full stop is not one, plus seven per blank.
  assert.equal(cost.words, 3 + 14)
  assert.equal(video.skeletonCost(null), null)
})

test('the cost readout warns when a sheet turns into an essay', () => {
  // A sweep with every row split is the longest the skeleton ever gets, and the
  // readout must say so rather than quietly looking fine.
  const cost = video.skeletonCost(video.buildVideoStarter(fill(2), 0))
  assert.ok(cost.blanks > 7, `a full sweep should show as expensive, got ${cost.blanks} blanks`)
  assert.equal(cost.roomy, false)
})

test('no unfilled placeholder survives into the output', () => {
  for (const value of [2, 1, 0, -1, -2]) {
    for (let seed = 0; seed < 5; seed++) {
      const text = video.buildVideoStarter(fill(value), seed)
      assert.ok(!/\{\w+\}/.test(text), `a sheet of all ${value} left a placeholder: ${text}`)
    }
  }
})

test('the review survives every combination of scores', () => {
  // Brute force the six rows that have no N/A, so a crash in a warning rule
  // cannot hide behind a combination nobody thought to try by hand.
  const vals = [2, 1, 0, -1, -2]
  const axes = ['overall', 'instruction', 'visual', 'motion', 'audio', 'artifacts']
  let count = 0
  const walk = (i, acc) => {
    if (i === axes.length) {
      for (const personId of [1, 0, video.NA]) {
        const scores = Object.assign({}, acc, { personId, contentPres: 0 })
        const r = video.reviewVideo(scores)
        assert.equal(r.complete, true)
        assert.ok(Array.isArray(r.flags))
        const text = video.buildVideoStarter(scores, count)
        assert.ok(!/\{\w+\}/.test(text))
        assert.ok(video.skeletonCost(text).blanks >= 1)
      }
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
