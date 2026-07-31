const TIMELINE_RE = /^(none|scroll|view)(?:\((.*)\))?$/i

function splitTopLevel(input, delimiter = ',') {
  const result = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    if (quote) {
      if (char === quote && input[index - 1] !== '\\') quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(') depth += 1
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if (char === delimiter && depth === 0) {
      result.push(input.slice(start, index).trim())
      start = index + 1
    }
  }
  result.push(input.slice(start).trim())
  return result.filter(Boolean)
}

export function parseAnimationTimeline(css = '') {
  const value = String(css).trim()
  const match = value.match(TIMELINE_RE)
  if (!match) return { source: 'none', axis: 'block', name: '', raw: value }
  const source = match[1].toLowerCase()
  if (source === 'none') return { source: 'none', axis: 'block', name: '' }
  const args = (match[2] || '').trim().split(/\s+/).filter(Boolean)
  const axisIndex = args.findIndex((token) => token === 'block' || token === 'inline')
  const axis = axisIndex >= 0 ? args[axisIndex] : 'block'
  const name = source === 'view'
    ? args.filter((_, index) => index !== axisIndex).join(' ')
    : ''
  return { source, axis, name }
}

export function emitAnimationTimeline(timeline = {}) {
  const source = timeline.source || 'none'
  if (source === 'none') return 'none'
  if (source === 'scroll') return 'scroll()'
  const args = [timeline.axis || 'block', String(timeline.name || '').trim()].filter(Boolean)
  return `view(${args.join(' ')})`
}

function parseRangePoint(value, fallbackName, fallbackOffset) {
  const tokens = String(value || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return { name: fallbackName, offset: fallbackOffset }
  const last = tokens[tokens.length - 1]
  if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(last)) {
    return { name: tokens.slice(0, -1).join(' ') || fallbackName, offset: last }
  }
  return { name: tokens.join(' '), offset: fallbackOffset }
}

export function parseKeyframes(input = '') {
  if (Array.isArray(input)) {
    return input.map((stop) => ({ progress: Number(stop.progress), value: String(stop.value || '').trim() }))
      .filter((stop) => Number.isFinite(stop.progress) && stop.value)
  }
  return splitTopLevel(String(input), ',').map((part) => {
    const match = part.match(/^\s*(-?(?:\d+\.?\d*|\.\d+))%\s*(?::|=>)?\s*(.+?)\s*$/)
    return match ? { progress: Number(match[1]), value: match[2] } : null
  }).filter(Boolean)
}

export function emitKeyframes(stops = []) {
  return parseKeyframes(stops)
    .sort((left, right) => left.progress - right.progress)
    .map((stop) => `${stop.progress}%: ${stop.value}`)
    .join(', ')
}

export function parseAnimationRange(css = '') {
  const value = String(css).trim()
  if (!value || value === 'normal') {
    return {
      start: { name: 'cover', offset: '0%' },
      end: { name: 'cover', offset: '100%' },
    }
  }
  const separator = value.match(/\s+(?:to|→)\s+/i)
  if (separator) {
    const index = separator.index
    return {
      start: parseRangePoint(value.slice(0, index), 'cover', '0%'),
      end: parseRangePoint(value.slice(index + separator[0].length), 'cover', '100%'),
    }
  }
  const tokens = value.split(/\s+/)
  const percentIndexes = tokens.reduce((out, token, index) => {
    if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(token)) out.push(index)
    return out
  }, [])
  if (percentIndexes.length >= 2) {
    const split = percentIndexes[0] + 1
    return {
      start: parseRangePoint(tokens.slice(0, split).join(' '), 'cover', '0%'),
      end: parseRangePoint(tokens.slice(split).join(' '), 'cover', '100%'),
    }
  }
  return {
    start: parseRangePoint(value, 'cover', '0%'),
    end: { name: 'cover', offset: '100%' },
  }
}

export function emitAnimationRange(range = {}) {
  const start = range.start || { name: 'cover', offset: '0%' }
  const end = range.end || { name: 'cover', offset: '100%' }
  return `${start.name || 'cover'} ${start.offset || '0%'} ${end.name || 'cover'} ${end.offset || '100%'}`
}
