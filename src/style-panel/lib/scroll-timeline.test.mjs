import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAnimationTimeline,
  emitAnimationTimeline,
  parseAnimationRange,
  emitAnimationRange,
  parseAnimationRangeStart,
  parseAnimationRangeEnd,
  emitAnimationRangeStart,
  emitAnimationRangeEnd,
  parseKeyframes,
  emitKeyframes,
  firstAndLastStops,
  parseViewTimelineName,
  emitViewTimelineName,
  parseAnimationName,
  emitAnimationName,
} from './scroll-timeline.js'

// ---------------------------------------------------------------------------
// animation-timeline
// ---------------------------------------------------------------------------

const timelineCases = [
  ['none', { source: 'none', axis: 'block', name: '', raw: '' }],
  ['scroll()', { source: 'scroll', axis: 'block', name: '', raw: '' }],
  ['scroll(block)', { source: 'scroll', axis: 'block', name: '', raw: '' }],
  ['scroll(inline)', { source: 'scroll', axis: 'inline', name: '', raw: '' }],
  ['view()', { source: 'view', axis: 'block', name: '', raw: '' }],
  ['view(block)', { source: 'view', axis: 'block', name: '', raw: '' }],
  ['view(inline)', { source: 'view', axis: 'inline', name: '', raw: '' }],
]
for (const [css, expected] of timelineCases) {
  test(`parse timeline: ${css}`, () => assert.deepEqual(parseAnimationTimeline(css), expected))
}

test('emit none timeline', () => assert.equal(emitAnimationTimeline({ source: 'none' }), 'none'))
test('emit scroll timeline default', () => assert.equal(emitAnimationTimeline({ source: 'scroll' }), 'scroll(block)'))
test('emit scroll timeline with axis', () => assert.equal(emitAnimationTimeline({ source: 'scroll', axis: 'inline' }), 'scroll(inline)'))
test('emit default view timeline', () => assert.equal(emitAnimationTimeline({ source: 'view' }), 'view(block)'))
test('emit named view timeline (name lives on view-timeline-name, NOT here)', () =>
  assert.equal(emitAnimationTimeline({ source: 'view', axis: 'inline', name: '--card' }), 'view(inline)'))
test('emit view with invalid name in source — names are dropped, not embedded', () =>
  assert.equal(emitAnimationTimeline({ source: 'view', axis: 'block', name: 'oops' }), 'view(block)'))
test('timeline canonical round trip', () => {
  const parsed = parseAnimationTimeline('view(inline)')
  assert.deepEqual(parseAnimationTimeline(emitAnimationTimeline(parsed)), parsed)
})
test('unknown timeline value is preserved as raw', () => {
  const parsed = parseAnimationTimeline('--custom')
  assert.equal(parsed.source, 'none')
  assert.equal(parsed.raw, '--custom')
  assert.equal(emitAnimationTimeline(parsed), '--custom')
})
test('hand-written view(block --hero) is preserved verbatim (we cannot split name out)', () => {
  const parsed = parseAnimationTimeline('view(block --hero)')
  assert.equal(parsed.source, 'view')
  assert.equal(parsed.raw, 'view(block --hero)')
  assert.equal(emitAnimationTimeline(parsed), 'view(block --hero)')
})
test('whitespace-only input yields none', () => {
  assert.deepEqual(parseAnimationTimeline('   '), { source: 'none', axis: 'block', name: '', raw: '' })
})

// ---------------------------------------------------------------------------
// view-timeline-name (separate property — the spec DOES NOT allow names in view())
// ---------------------------------------------------------------------------

test('parse view-timeline-name bare', () => assert.equal(parseViewTimelineName('--hero'), '--hero'))
test('parse view-timeline-name quoted', () => assert.equal(parseViewTimelineName('"--hero"'), '--hero'))
test('emit view-timeline-name strips quotes', () => assert.equal(emitViewTimelineName('"--hero"'), '--hero'))
test('view-timeline-name round trip', () => {
  assert.equal(emitViewTimelineName(parseViewTimelineName('  "--x"  ')), '--x')
})

// ---------------------------------------------------------------------------
// animation-name (scroll-driven contexts pass animation-name through verbatim)
// ---------------------------------------------------------------------------

test('parse animation-name trims', () => assert.equal(parseAnimationName('  fade-in  '), 'fade-in'))
test('emit animation-name trims', () => assert.equal(emitAnimationName('  fade-in  '), 'fade-in'))

// ---------------------------------------------------------------------------
// animation-range
// ---------------------------------------------------------------------------

test('parse normal range defaults', () => assert.deepEqual(parseAnimationRange('normal'), {
  start: { name: 'cover', offset: '0%', raw: '' },
  end: { name: 'cover', offset: '100%', raw: '' },
  raw: '',
}))
test('empty range defaults', () => assert.deepEqual(parseAnimationRange(''), {
  start: { name: 'cover', offset: '0%', raw: '' },
  end: { name: 'cover', offset: '100%', raw: '' },
  raw: '',
}))
test('parse multi-token range', () => assert.deepEqual(parseAnimationRange('cover 0% cover 100%'), {
  start: { name: 'cover', offset: '0%', raw: '' },
  end: { name: 'cover', offset: '100%', raw: '' },
  raw: '',
}))
test('parse arrow-separated range', () => assert.deepEqual(parseAnimationRange('entry 25% to exit 75%'), {
  start: { name: 'entry', offset: '25%', raw: '' },
  end: { name: 'exit', offset: '75%', raw: '' },
  raw: '',
}))
test('parse → arrow', () => assert.deepEqual(parseAnimationRange('entry 25% → exit 75%'), {
  start: { name: 'entry', offset: '25%', raw: '' },
  end: { name: 'exit', offset: '75%', raw: '' },
  raw: '',
}))
test('parse entry-crossing / exit-crossing', () => assert.deepEqual(parseAnimationRange('entry-crossing 10% to exit-crossing 90%'), {
  start: { name: 'entry-crossing', offset: '10%', raw: '' },
  end: { name: 'exit-crossing', offset: '90%', raw: '' },
  raw: '',
}))
test('parse length offsets (px, em, rem)', () => {
  assert.deepEqual(parseAnimationRange('entry 100px to exit 5em'), {
    start: { name: 'entry', offset: '100px', raw: '' },
    end: { name: 'exit', offset: '5em', raw: '' },
    raw: '',
  })
})
test('parse calc() offsets', () => {
  assert.deepEqual(parseAnimationRange('cover calc(50% + 10px) cover calc(100% - 20px)'), {
    start: { name: 'cover', offset: 'calc(50% + 10px)', raw: '' },
    end: { name: 'cover', offset: 'calc(100% - 20px)', raw: '' },
    raw: '',
  })
})
test('parse single-keyword offsets (contain alone is valid)', () => assert.deepEqual(parseAnimationRange('contain'), {
  start: { name: 'contain', offset: '', raw: '' },
  end: { name: 'cover', offset: '100%', raw: '' },
  raw: '',
}))
test('parse negative percentages', () => assert.deepEqual(parseAnimationRange('cover -10% to cover 110%'), {
  start: { name: 'cover', offset: '-10%', raw: '' },
  end: { name: 'cover', offset: '110%', raw: '' },
  raw: '',
}))
test('parse float percentages', () => assert.deepEqual(parseAnimationRange('cover 12.5% cover 87.5%'), {
  start: { name: 'cover', offset: '12.5%', raw: '' },
  end: { name: 'cover', offset: '87.5%', raw: '' },
  raw: '',
}))
test('parse no-offset name tokens', () => assert.deepEqual(parseAnimationRange('entry to exit'), {
  start: { name: 'entry', offset: '', raw: '' },
  end: { name: 'exit', offset: '', raw: '' },
  raw: '',
}))
test('malformed range falls back gracefully', () => {
  const parsed = parseAnimationRange('???')
  assert.equal(parsed.start.name, '???')
  assert.equal(parsed.end.name, 'cover')
  assert.equal(parsed.end.offset, '100%')
})
test('emit range', () => assert.equal(emitAnimationRange({
  start: { name: 'entry', offset: '20%' },
  end: { name: 'exit', offset: '80%' },
}), 'entry 20% exit 80%'))
test('emit range omits default offsets', () => assert.equal(emitAnimationRange({
  start: { name: 'entry', offset: '' },
  end: { name: 'exit', offset: '' },
}), 'entry exit'))
test('range round trip (lengths)', () => {
  const range = parseAnimationRange('entry 100px to exit 200px')
  assert.deepEqual(parseAnimationRange(emitAnimationRange(range)), range)
})
test('range round trip (calc)', () => {
  const range = parseAnimationRange('cover calc(50% + 10px) cover calc(100% - 20px)')
  assert.deepEqual(parseAnimationRange(emitAnimationRange(range)), range)
})
test('range round trip (keywords)', () => {
  const range = parseAnimationRange('entry to exit')
  assert.deepEqual(parseAnimationRange(emitAnimationRange(range)), range)
})
test('range raw is preserved when set', () => {
  assert.equal(emitAnimationRange({ raw: 'whatever the user typed' }), 'whatever the user typed')
})

// ---------------------------------------------------------------------------
// animation-range-start / animation-range-end longhands
// ---------------------------------------------------------------------------

test('parseAnimationRangeStart defaults', () => assert.deepEqual(parseAnimationRangeStart(''), {
  name: 'cover', offset: '0%', raw: '',
}))
test('parseAnimationRangeStart keyword', () => assert.deepEqual(parseAnimationRangeStart('entry 25%'), {
  name: 'entry', offset: '25%', raw: '',
}))
test('parseAnimationRangeStart length', () => assert.deepEqual(parseAnimationRangeStart('100px'), {
  name: 'cover', offset: '100px', raw: '',
}))
test('parseAnimationRangeEnd keyword', () => assert.deepEqual(parseAnimationRangeEnd('exit 75%'), {
  name: 'exit', offset: '75%', raw: '',
}))
test('parseAnimationRangeEnd defaults when empty', () => assert.deepEqual(parseAnimationRangeEnd(''), {
  name: 'cover', offset: '100%', raw: '',
}))
test('emitAnimationRangeStart / End round trip', () => {
  const start = parseAnimationRangeStart('entry 25%')
  assert.deepEqual(parseAnimationRangeStart(emitAnimationRangeStart(start)), start)
})

// ---------------------------------------------------------------------------
// keyframes
// ---------------------------------------------------------------------------

test('parse two keyframes', () => assert.deepEqual(parseKeyframes('0%: 0, 100%: 1'), [
  { progress: 0, value: '0' }, { progress: 100, value: '1' },
]))
test('parse transform keyframes with commas', () => assert.deepEqual(parseKeyframes('0%: translate(0, 10px), 100%: translate(0, 0)'), [
  { progress: 0, value: 'translate(0, 10px)' }, { progress: 100, value: 'translate(0, 0)' },
]))
test('parse clip-path keyframes with commas', () => assert.deepEqual(parseKeyframes('0%: inset(20% 10%), 100%: inset(0 0)'), [
  { progress: 0, value: 'inset(20% 10%)' }, { progress: 100, value: 'inset(0 0)' },
]))
test('parse arrow keyframe syntax', () => assert.deepEqual(parseKeyframes('25% => .25'), [{ progress: 25, value: '.25' }]))
test('parse multiple stops out of order', () => assert.deepEqual(parseKeyframes('100%: 1, 0%: 0, 50%: .5'), [
  { progress: 100, value: '1' }, { progress: 0, value: '0' }, { progress: 50, value: '.5' },
]))
test('ignore malformed keyframes', () => assert.deepEqual(parseKeyframes('hello, 50%: .5'), [{ progress: 50, value: '.5' }]))
test('ignore empty input', () => assert.deepEqual(parseKeyframes(''), []))
test('emit sorted keyframes', () => assert.equal(emitKeyframes([
  { progress: 100, value: '1' }, { progress: 0, value: '0' },
]), '0%: 0, 100%: 1'))
test('emit clamps progress to 0–100', () => assert.equal(emitKeyframes([
  { progress: -10, value: '0' }, { progress: 200, value: '1' }, { progress: 50, value: '.5' },
]), '0%: 0, 50%: .5, 100%: 1'))
test('emit dedups identical progress (last wins)', () => assert.equal(emitKeyframes([
  { progress: 50, value: 'first' }, { progress: 50, value: 'second' },
]), '50%: second'))
test('array parser coerces progress and trims values', () => assert.deepEqual(parseKeyframes([{ progress: '50', value: '  .5  ' }]), [{ progress: 50, value: '.5' }]))
test('array parser clamps and dedups', () => assert.deepEqual(parseKeyframes([
  { progress: -5, value: 'a' }, { progress: 150, value: 'b' }, { progress: 50, value: 'c' }, { progress: 50, value: 'd' },
]), [{ progress: 0, value: 'a' }, { progress: 100, value: 'b' }, { progress: 50, value: 'd' }]))
test('array parser drops invalid entries', () => assert.deepEqual(parseKeyframes([
  { progress: 'not-a-number', value: 'x' }, { progress: 50, value: '' }, { progress: 50, value: 'kept' },
]), [{ progress: 50, value: 'kept' }]))
test('keyframe round trip', () => {
  const stops = [{ progress: 0, value: 'translateY(2rem)' }, { progress: 45, value: 'translateY(1rem)' }, { progress: 100, value: 'none' }]
  assert.deepEqual(parseKeyframes(emitKeyframes(stops)), stops)
})

// ---------------------------------------------------------------------------
// firstAndLastStops (used to drive the actual CSS property from the multi-stop store)
// ---------------------------------------------------------------------------

test('firstAndLastStops picks bookends from sorted list', () => assert.deepEqual(firstAndLastStops([
  { progress: 100, value: '1' }, { progress: 0, value: '0' }, { progress: 50, value: '.5' },
]), [{ progress: 0, value: '0' }, { progress: 100, value: '1' }]))
test('firstAndLastStops on single stop', () => assert.deepEqual(firstAndLastStops([
  { progress: 50, value: '.5' },
]), [{ progress: 50, value: '.5' }]))
test('firstAndLastStops on empty list', () => assert.deepEqual(firstAndLastStops([]), []))
test('firstAndLastStops accepts a CSS string', () => assert.deepEqual(firstAndLastStops('0%: 0, 50%: .5, 100%: 1'), [
  { progress: 0, value: '0' }, { progress: 100, value: '1' },
]))

// ---------------------------------------------------------------------------
// multi-property round trip — the realistic panel scenario
// ---------------------------------------------------------------------------

test('full panel scenario: parse → emit survives a round trip', () => {
  const css = `view(inline)`
  const timeline = parseAnimationTimeline(css)
  const emitted = emitAnimationTimeline(timeline)
  assert.equal(emitted, 'view(inline)')

  const range = parseAnimationRange('entry 20% to exit 80%')
  assert.equal(emitAnimationRange(range), 'entry 20% exit 80%')

  const name = parseViewTimelineName('--hero')
  assert.equal(emitViewTimelineName(name), '--hero')

  const stops = emitKeyframes([
    { progress: 0, value: 'translateY(40px)' },
    { progress: 100, value: 'translateY(0px)' },
  ])
  assert.equal(stops, '0%: translateY(40px), 100%: translateY(0px)')
})