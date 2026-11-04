import { fitCalibration, formatAbsorbance, formatPpm, ppmAt, type Calibration } from './calibration.ts'
import { absorbanceChannels, checkHue, type HueCheck } from './colorimetry.ts'
import type { SampleRecord } from './storage.ts'
import {
  CHANNEL_LABEL,
  type Blank,
  type Channel,
  type ChannelChoice,
  type Standard,
} from './types.ts'

export type SampleEvaluation = {
  fit: Calibration | null
  ppm: number | null
  absorbance: number | null
  channel: Channel | null
  hue: HueCheck | null
  ppmLabel: string | null
  detail: string
  note: string
  warning: boolean
  chart: { ppm: number; absorbance: number } | null
}

export function evaluateSample(
  blank: Blank | null,
  standards: Standard[],
  channelChoice: ChannelChoice,
  sample: SampleRecord | null,
): SampleEvaluation {
  const fit = fitFor(blank, standards, channelChoice)
  if (!blank) return emptyReading(fit, 'Capture a clear-solvent blank before measuring.')
  if (!fit || !sample) return emptyReading(fit, 'Add at least two standards, then measure a sample.')

  const absorbance = absorbanceChannels(sample.linear, blank.linear)
  const channel = fit.chosen.channel
  const value = absorbance[channel]
  const range = ppmRange(standards)
  const ppm = value === null ? null : ppmAt(fit.chosen, value, range)
  const hue = checkHue(
    sample.srgb,
    standards.map((standard) => standard.srgb),
  )
  const outside =
    ppm !== null && (ppm < range.min - range.span * 0.1 || ppm > range.max + range.span * 0.1)
  const notes: string[] = []
  if (value === null) {
    notes.push(`The blank is too dark on the ${CHANNEL_LABEL[channel].toLowerCase()} channel.`)
  }
  if (!fit.rising) notes.push('Absorbance does not rise with concentration on this channel.')
  if (outside) notes.push('This reading is outside the calibrated range.')
  notes.push(hue.message)

  return {
    fit,
    ppm,
    absorbance: value,
    channel,
    hue,
    ppmLabel: ppm === null ? null : formatPpm(ppm),
    detail: value === null ? '' : `${CHANNEL_LABEL[channel]} absorbance ${formatAbsorbance(value)}`,
    note: notes.join(' '),
    warning: hue.status === 'shift' || outside || !fit.rising || value === null,
    chart: ppm === null || value === null ? null : { ppm, absorbance: value },
  }
}

function fitFor(blank: Blank | null, standards: Standard[], channel: ChannelChoice) {
  if (!blank || standards.length < 2) return null
  return fitCalibration(
    standards.map((standard) => ({
      ppm: standard.ppm,
      absorbance: absorbanceChannels(standard.linear, blank.linear),
    })),
    channel,
  )
}

function emptyReading(fit: Calibration | null, note: string): SampleEvaluation {
  return {
    fit,
    ppm: null,
    absorbance: null,
    channel: fit?.chosen.channel ?? null,
    hue: null,
    ppmLabel: null,
    detail: '',
    note,
    warning: false,
    chart: null,
  }
}

function ppmRange(standards: Standard[]) {
  const values = standards.map((standard) => standard.ppm)
  const min = Math.min(...values)
  const max = Math.max(...values)
  return { min, max, span: Math.max(max - min, 0) }
}
