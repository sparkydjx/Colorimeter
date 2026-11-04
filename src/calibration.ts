import { linearRegression, rSquared } from 'simple-statistics'
import { CHANNEL_LABEL, CHANNELS, type Channel, type ChannelChoice } from './types.ts'

export type ChannelFit = {
  channel: Channel
  model: 'linear' | 'quadratic'
  /** Coefficient of determination from simple-statistics. */
  r2: number
  adjustedR2: number
  /** Change in absorbance from the lowest standard to the highest. */
  span: number
  /** A = a·ppm² + b·ppm + c. A straight line keeps a at 0. */
  a: number
  b: number
  c: number
}

export type Calibration = {
  chosen: ChannelFit
  channels: Record<Channel, ChannelFit | null>
  rising: boolean
  summary: string
}

export type CalibrationPoint = {
  ppm: number
  absorbance: Record<Channel, number | null>
}

const QUADRATIC_GAIN = 0.02

export function absorbanceAt(fit: ChannelFit, ppm: number): number {
  return fit.a * ppm * ppm + fit.b * ppm + fit.c
}

export function ppmAt(
  fit: ChannelFit,
  absorbance: number,
  range: { min: number; max: number },
): number | null {
  const roots = solveForPpm(fit.a, fit.b, fit.c - absorbance)
  return pickRoot(roots, range)
}

export function fitCalibration(
  points: CalibrationPoint[],
  choice: ChannelChoice,
): Calibration | null {
  if (points.length < 2) return null

  const ppm = points.map((point) => point.ppm)
  const range = { min: Math.min(...ppm), max: Math.max(...ppm) }
  const channels = {
    r: fitChannel('r', points, range),
    g: fitChannel('g', points, range),
    b: fitChannel('b', points, range),
  }

  const chosen =
    choice === 'auto' ? chooseChannel(channels) : channels[choice]
  if (!chosen) return null

  return {
    chosen,
    channels,
    rising: chosen.span > 1e-4,
    summary: describeCalibration(chosen, points.length),
  }
}

function fitChannel(
  channel: Channel,
  points: CalibrationPoint[],
  range: { min: number; max: number },
): ChannelFit | null {
  const pairs: number[][] = []
  for (const point of points) {
    const value = point.absorbance[channel]
    if (value === null || !Number.isFinite(value)) return null
    pairs.push([point.ppm, value])
  }

  const linear = fitLinear(channel, pairs, range)
  const quadratic = pairs.length >= 4 ? fitQuadratic(channel, pairs, range) : null
  if (
    quadratic &&
    quadratic.adjustedR2 >= linear.adjustedR2 + QUADRATIC_GAIN
  ) {
    return quadratic
  }
  return linear
}

function fitLinear(
  channel: Channel,
  pairs: number[][],
  range: { min: number; max: number },
): ChannelFit {
  let { m, b } = linearRegression(pairs)
  if (!Number.isFinite(m) || !Number.isFinite(b)) {
    m = 0
    b = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
  }
  const predict = (ppm: number) => m * ppm + b
  const r2 = goodness(pairs, predict)
  const fit: ChannelFit = {
    channel,
    model: 'linear',
    r2,
    adjustedR2: adjustR2(r2, pairs.length, 1),
    span: 0,
    a: 0,
    b: m,
    c: b,
  }
  fit.span = absorbanceAt(fit, range.max) - absorbanceAt(fit, range.min)
  return fit
}

function fitQuadratic(
  channel: Channel,
  pairs: number[][],
  range: { min: number; max: number },
): ChannelFit | null {
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let s4 = 0
  let t0 = 0
  let t1 = 0
  let t2 = 0
  for (const [x, y] of pairs) {
    const x2 = x * x
    s1 += x
    s2 += x2
    s3 += x2 * x
    s4 += x2 * x2
    t0 += y
    t1 += x * y
    t2 += x2 * y
  }
  const solved = solve3(
    [
      [s4, s3, s2],
      [s3, s2, s1],
      [s2, s1, pairs.length],
    ],
    [t2, t1, t0],
  )
  if (!solved) return null
  const [a, b, c] = solved
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null
  const predict = (ppm: number) => a * ppm * ppm + b * ppm + c
  const r2 = goodness(pairs, predict)
  const fit: ChannelFit = {
    channel,
    model: 'quadratic',
    r2,
    adjustedR2: adjustR2(r2, pairs.length, 2),
    span: 0,
    a,
    b,
    c,
  }
  fit.span = absorbanceAt(fit, range.max) - absorbanceAt(fit, range.min)
  return fit
}

function chooseChannel(
  channels: Record<Channel, ChannelFit | null>,
): ChannelFit | null {
  const available = CHANNELS.map((channel) => channels[channel]).filter(
    (fit): fit is ChannelFit => fit !== null,
  )
  if (!available.length) return null
  const rising = available.filter((fit) => fit.span > 1e-4)
  const pool = rising.length ? rising : available
  return [...pool].sort((left, right) => {
    const quality = right.adjustedR2 - left.adjustedR2
    if (Math.abs(quality) > 0.01) return quality
    return right.span - left.span
  })[0]
}

function goodness(pairs: number[][], predict: (ppm: number) => number): number {
  const mean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
  const total = pairs.reduce((sum, pair) => sum + (pair[1] - mean) ** 2, 0)
  if (total === 0) {
    const residual = pairs.reduce((sum, pair) => sum + (pair[1] - predict(pair[0])) ** 2, 0)
    return residual === 0 ? 1 : 0
  }
  return rSquared(pairs, predict)
}

/** p is the number of predictors, excluding the intercept. */
function adjustR2(r2: number, count: number, predictors: number): number {
  const denom = count - predictors - 1
  if (denom <= 0) return r2
  return 1 - ((1 - r2) * (count - 1)) / denom
}

function solve3(matrix: number[][], target: number[]): number[] | null {
  const rows = matrix.map((row, index) => [...row, target[index]])
  const size = rows.length
  for (let col = 0; col < size; col += 1) {
    let pivot = col
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row
    }
    if (Math.abs(rows[pivot][col]) < 1e-12) return null
    ;[rows[col], rows[pivot]] = [rows[pivot], rows[col]]
    const divisor = rows[col][col]
    for (let column = col; column <= size; column += 1) rows[col][column] /= divisor
    for (let row = 0; row < size; row += 1) {
      if (row === col) continue
      const factor = rows[row][col]
      for (let column = col; column <= size; column += 1) {
        rows[row][column] -= factor * rows[col][column]
      }
    }
  }
  return rows.map((row) => row[size])
}

function solveForPpm(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return []
    return [-c / b]
  }
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return []
  const root = Math.sqrt(discriminant)
  const sign = b >= 0 ? 1 : -1
  const q = -0.5 * (b + sign * root)
  if (Math.abs(q) < 1e-15) return [0, -b / a]
  return [q / a, c / q]
}

function pickRoot(roots: number[], range: { min: number; max: number }): number | null {
  const finite = roots.filter((root) => Number.isFinite(root))
  if (!finite.length) return null
  const span = Math.max(range.max - range.min, 1)
  const low = range.min - span * 0.25
  const high = range.max + span * 0.25
  const inside = finite.filter((root) => root >= low && root <= high)
  const pool = inside.length ? inside : finite
  const middle = (range.min + range.max) / 2
  return pool.reduce((best, root) =>
    Math.abs(root - middle) < Math.abs(best - middle) ? root : best,
  )
}

export function fitEquation(fit: ChannelFit): string {
  return fit.model === 'linear'
    ? polynomial([
        { value: fit.b, suffix: ' ppm' },
        { value: fit.c, suffix: '' },
      ])
    : polynomial([
        { value: fit.a, suffix: ' ppm²' },
        { value: fit.b, suffix: ' ppm' },
        { value: fit.c, suffix: '' },
      ])
}

function describeCalibration(fit: ChannelFit, count: number): string {
  const name = CHANNEL_LABEL[fit.channel]
  const equation = fitEquation(fit)
  const shape =
    fit.model === 'quadratic'
      ? 'Quadratic fit, used because the standards bend away from a straight line.'
      : count >= 4
        ? 'Straight-line fit. A curve did not explain the standards better.'
        : 'Straight-line fit.'
  return `${name} channel. ${equation}. R² ${fit.r2.toFixed(3)}. ${shape}`
}

function polynomial(terms: { value: number; suffix: string }[]): string {
  const visible = terms.filter((term, index) => index === 0 || Math.abs(term.value) >= 1e-8)
  const body = visible
    .map((term, index) => {
      const magnitude = formatCoef(Math.abs(term.value))
      const piece = `${magnitude}${term.suffix}`
      if (index === 0) return term.value < 0 ? `-${piece}` : piece
      return `${term.value < 0 ? '−' : '+'} ${piece}`
    })
    .join(' ')
  return `A = ${body}`
}

function formatCoef(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value !== 0 && (value < 0.0001 || value >= 10000)) return value.toExponential(2)
  return value.toPrecision(4).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1')
}

export function formatPpm(value: number): string {
  const digits = Math.abs(value) >= 100 ? 1 : 2
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatAbsorbance(value: number): string {
  return value.toFixed(3)
}
