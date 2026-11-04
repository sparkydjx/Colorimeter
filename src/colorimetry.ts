import Color from 'colorjs.io'
import type { Channel, Patch, RGB } from './types.ts'

/** Below this intensity the blank is clipped and absorbance is meaningless. */
const MIN_BLANK = 0.002

/** Hue is unstable when OKLCh chroma is this low. */
const MIN_CHROMA = 0.02

/** Degrees of OKLCh hue away from the standards that counts as a different color. */
export const HUE_TOLERANCE = 18

export function srgbByteToLinear(byte: number): number {
  const s = Math.min(255, Math.max(0, byte)) / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function linearToSrgbByte(value: number): number {
  const v = Math.min(1, Math.max(0, value))
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  return Math.round(Math.min(255, Math.max(0, s * 255)))
}

export function linearToSrgb(linear: RGB): RGB {
  return {
    r: linearToSrgbByte(linear.r),
    g: linearToSrgbByte(linear.g),
    b: linearToSrgbByte(linear.b),
  }
}

export function patchFromLinear(sums: RGB, count: number): Patch {
  const linear = {
    r: sums.r / count,
    g: sums.g / count,
    b: sums.b / count,
  }
  return { linear, srgb: linearToSrgb(linear) }
}

/** Beer–Lambert absorbance of one linear channel against the solvent blank. */
export function absorbance(sample: number, blank: number): number | null {
  if (!(blank >= MIN_BLANK)) return null
  const ratio = Math.max(sample, 1e-6) / blank
  return -Math.log10(ratio)
}

export function absorbanceChannels(sample: RGB, blank: RGB): Record<Channel, number | null> {
  return {
    r: absorbance(sample.r, blank.r),
    g: absorbance(sample.g, blank.g),
    b: absorbance(sample.b, blank.b),
  }
}

export type Oklch = { l: number; c: number; h: number | null }

export function oklchFromSrgb(srgb: RGB): Oklch {
  const color = new Color('srgb', [srgb.r / 255, srgb.g / 255, srgb.b / 255])
  const converted = color.to('oklch')
  const [l, c, h] = converted.coords
  return {
    l: typeof l === 'number' && Number.isFinite(l) ? l : 0,
    c: typeof c === 'number' && Number.isFinite(c) ? c : 0,
    h: typeof h === 'number' && Number.isFinite(h) ? (h + 360) % 360 : null,
  }
}

export function hueDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360
  return delta > 180 ? 360 - delta : delta
}

function circularMean(hues: number[]): number {
  let x = 0
  let y = 0
  for (const hue of hues) {
    const radians = (hue * Math.PI) / 180
    x += Math.cos(radians)
    y += Math.sin(radians)
  }
  return (Math.atan2(y, x) * 180) / Math.PI
}

export type HueStatus = 'match' | 'shift' | 'faint' | 'unready'

export type HueCheck = {
  status: HueStatus
  message: string
  delta: number | null
}

export function checkHue(sample: RGB, standards: RGB[]): HueCheck {
  const sampleColor = oklchFromSrgb(sample)
  if (sampleColor.c < MIN_CHROMA || sampleColor.h === null) {
    return {
      status: 'faint',
      delta: null,
      message: 'The sample is too close to the blank for a hue check.',
    }
  }

  const reference = standards
    .map((color) => oklchFromSrgb(color))
    .filter((color) => color.c >= MIN_CHROMA && color.h !== null)
    .map((color) => color.h as number)

  if (!reference.length) {
    return {
      status: 'unready',
      delta: null,
      message: 'Hue is checked once a standard has visible color.',
    }
  }

  const expected = (circularMean(reference) + 360) % 360
  const delta = hueDistance(sampleColor.h, expected)
  if (delta > HUE_TOLERANCE) {
    return {
      status: 'shift',
      delta,
      message: `Hue is ${delta.toFixed(0)}° away from the calibration oils. Check the cuvette, solvent, and light before trusting this ppm.`,
    }
  }

  return {
    status: 'match',
    delta,
    message: 'Hue matches the calibration oils.',
  }
}

export function cssColor(srgb: RGB): string {
  return `rgb(${srgb.r} ${srgb.g} ${srgb.b})`
}
