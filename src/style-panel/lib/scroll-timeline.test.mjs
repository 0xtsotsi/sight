import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAnimationTimeline,
  emitAnimationTimeline,
  parseAnimationRange,
  emitAnimationRange,
  parseKeyframes,
  emitKeyframes,
} from './scroll-timeline.js'

const timelineCases = [
  ['none', { source: 'none', axis: 'block', name: '' }],
  ['scroll()', { source: 'scroll', axis: 'block', name: '' }],
  ['scroll(block)', { source: 'scroll', axis: 'block', name: '' }],
  ['scroll(inline)', { source: 'scroll', axis: 'inline', name: '' }],
  ['view()', { source: 'view', axis: 'block', name: '' }],
  ['view(block)', { source: 'view', axis: 'block', name: '' }],
  ['view(inline)', { source: 'view', axis: 'inline', name: '' }],
  ['view(block --hero)', { source: 'view', axis: 'block', name: '--hero' }],
  ['view(--hero inline)', { source: 'view', axis: 'inline', name: '--hero' }],
]
for (const [css, expected] of timelineCases) {
  test(`parse timeline: ${css}`, () => assert.deepEqual(parseAnimationTimeline(css), expected))
}

test('emit none timeline', () => assert.equal(emitAnimationTimeline({ source: 'none' }), 'none'))
test('emit scroll timeline', () => assert.equal(emitAnimationTimeline({ source: 'scroll', axis: 'inline' }), 'scroll()'))
test('emit default view timeline', () => assert.equal(emitAnimationTimeline({ source: 'view' }), 'view(block)'))
test('emit named view timeline', () => assert.equal(emitAnimationTimeline({ source: 'view', axis: 'inline', name: '--card' }), 'view(inline --card)'))
test('timeline canonical round trip', () => {
  const parsed = parseAnimationTimeline('view(--hero inline)')
  assert.deepEqual(parseAnimationTimeline(emitAnimationTimeline(parsed)), parsed)
})
test('unknown timeline is preserved as raw metadata', () => {
  assert.deepEqual(parseAnimationTimeline('--custom'), { source: 'none', axis: 'block', name: '', raw: '--custom' })
})

test('parse normal range defaults', () => assert.deepEqual(parseAnimationRange('normal'), {
  start: { name: 'cover', offset: '0%' }, end: { name: 'cover', offset: '100%' },
}))
test('parse multi-token range', () => assert.deepEqual(parseAnimationRange('cover 0% cover 100%'), {
  start: { name: 'cover', offset: '0%' }, end: { name: 'cover', offset: '100%' },
}))
test('parse arrow-separated range', () => assert.deepEqual(parseAnimationRange('entry 25% → exit 75%'), {
  start: { name: 'entry', offset: '25%' }, end: { name: 'exit', offset: '75%' },
}))
test('parse to-separated range', () => assert.deepEqual(parseAnimationRange('entry-crossing 10% to exit-crossing 90%'), {
  start: { name: 'entry-crossing', offset: '10%' }, end: { name: 'exit-crossing', offset: '90%' },
}))
test('emit range', () => assert.equal(emitAnimationRange({
  start: { name: 'entry', offset: '20%' }, end: { name: 'exit', offset: '80%' },
}), 'entry 20% exit 80%'))
test('range round trip', () => {
  const range = parseAnimationRange('contain 12.5% contain 87.5%')
  assert.deepEqual(parseAnimationRange(emitAnimationRange(range)), range)
})

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
test('ignore malformed keyframes', () => assert.deepEqual(parseKeyframes('hello, 50%: .5'), [{ progress: 50, value: '.5' }]))
test('emit sorted keyframes', () => assert.equal(emitKeyframes([
  { progress: 100, value: '1' }, { progress: 0, value: '0' },
]), '0%: 0, 100%: 1'))
test('keyframe round trip', () => {
  const stops = [{ progress: 0, value: 'translateY(2rem)' }, { progress: 45, value: 'translateY(1rem)' }, { progress: 100, value: 'none' }]
  assert.deepEqual(parseKeyframes(emitKeyframes(stops)), stops)
})
test('array parser coerces progress and trims values', () => assert.deepEqual(parseKeyframes([{ progress: '50', value: '  .5  ' }]), [{ progress: 50, value: '.5' }]))
