import {
  fitCalibration,
  formatAbsorbance,
  formatPpm,
  ppmAt,
  type Calibration,
  type ChannelFit,
} from './calibration.ts'
import { drawChart } from './chart.ts'
import { absorbanceChannels, checkHue, cssColor } from './colorimetry.ts'
import { describeLock, type LightLock } from './camera.ts'
import type { SampleRecord } from './storage.ts'
import {
  CHANNEL_LABEL,
  CHANNELS,
  type Blank,
  type Channel,
  type ChannelChoice,
  type RGB,
  type Standard,
} from './types.ts'

export type ViewModel = {
  blank: Blank | null
  standards: Standard[]
  channel: ChannelChoice
  sample: SampleRecord | null
  lock: LightLock | null
  cameraReady: boolean
  cameraError: string
  canLockLight: boolean
  lightLocked: boolean
  busy: boolean
  notice: string
}

export function render(model: ViewModel) {
  const fit = fitFor(model)
  const reading = readingFor(model, fit)

  document.querySelector('#notice')!.textContent = model.notice
  document.querySelector('#lock-status')!.textContent = model.cameraReady ? describeLock(model.lock) : ''
  const cameraMessage = document.querySelector<HTMLParagraphElement>('#camera-message')!
  cameraMessage.hidden = model.cameraReady
  cameraMessage.textContent = model.cameraReady
    ? ''
    : model.cameraError || 'Start the camera when you are ready to measure.'

  const toggle = document.querySelector<HTMLButtonElement>('#camera-toggle')!
  toggle.textContent = model.cameraReady ? 'Stop camera' : 'Start camera'
  toggle.disabled = model.busy

  const lock = document.querySelector<HTMLButtonElement>('#lock')!
  lock.textContent = model.lightLocked ? 'Unlock light' : 'Lock light'
  lock.disabled = model.busy || !model.cameraReady || !model.canLockLight

  const ready = model.cameraReady && !model.busy
  document.querySelector<HTMLButtonElement>('#capture-blank')!.disabled = !ready
  document.querySelector<HTMLButtonElement>('#measure')!.disabled =
    !ready || !model.blank || model.standards.length < 2
  document.querySelector<HTMLButtonElement>('#add-standard')!.disabled = !ready || !model.blank
  document.querySelector<HTMLInputElement>('#ppm')!.disabled = model.busy

  const readout = document.querySelector<HTMLElement>('#readout')!
  readout.classList.toggle('is-warning', reading.warning)
  const ppmValue = document.querySelector<HTMLParagraphElement>('#ppm-value')!
  ppmValue.textContent = ''
  if (reading.ppm === null) {
    ppmValue.textContent = '—'
  } else {
    ppmValue.append(reading.ppm, unit('ppm'))
  }
  document.querySelector('#readout-detail')!.textContent = reading.detail
  document.querySelector('#hue-note')!.textContent = reading.note
  paintSwatch(document.querySelector('#sample-swatch')!, model.sample?.srgb ?? null)

  document.querySelector('#fit-summary')!.textContent = fit
    ? fit.summary
    : model.standards.length === 1
      ? 'Add one more standard to fit the curve.'
      : 'Capture a blank, then add at least two standards.'

  renderChannels(model.channel, fit)
  renderStandards(model, fit?.chosen.channel ?? null)
  drawChart(
    document.querySelector('#chart')!,
    fit?.chosen ?? null,
    chartPoints(model, fit?.chosen ?? null),
    reading.chart,
  )

  document.querySelector<HTMLButtonElement>('#clear')!.disabled =
    model.busy || (!model.blank && model.standards.length === 0 && !model.sample)
}

function fitFor(model: ViewModel): Calibration | null {
  if (!model.blank || model.standards.length < 2) return null
  return fitCalibration(
    model.standards.map((standard) => ({
      ppm: standard.ppm,
      absorbance: absorbanceChannels(standard.linear, model.blank!.linear),
    })),
    model.channel,
  )
}

function readingFor(model: ViewModel, fit: Calibration | null) {
  if (!model.blank) {
    return blankReading('Capture a clear-solvent blank before measuring.')
  }
  if (!fit || !model.sample) {
    return blankReading('Add at least two standards, then measure a sample.')
  }

  const absorbance = absorbanceChannels(model.sample.linear, model.blank.linear)
  const value = absorbance[fit.chosen.channel]
  const range = ppmRange(model.standards)
  const ppm = value === null ? null : ppmAt(fit.chosen, value, range)
  const hue = checkHue(
    model.sample.srgb,
    model.standards.map((standard) => standard.srgb),
  )
  const outside =
    ppm !== null && (ppm < range.min - range.span * 0.1 || ppm > range.max + range.span * 0.1)
  const notes: string[] = []
  if (value === null) {
    notes.push(
      `The blank is too dark on the ${CHANNEL_LABEL[fit.chosen.channel].toLowerCase()} channel.`,
    )
  }
  if (!fit.rising) notes.push('Absorbance does not rise with concentration on this channel.')
  if (outside) notes.push('This reading is outside the calibrated range.')
  notes.push(hue.message)

  return {
    ppm: ppm === null ? null : formatPpm(ppm),
    detail:
      value === null
        ? ''
        : `${CHANNEL_LABEL[fit.chosen.channel]} absorbance ${formatAbsorbance(value)}`,
    note: notes.join(' '),
    warning: hue.status === 'shift' || outside || !fit.rising || value === null,
    chart: ppm === null || value === null ? null : { ppm, absorbance: value },
  }
}

function blankReading(note: string) {
  return {
    ppm: null as string | null,
    detail: '',
    note,
    warning: false,
    chart: null as { ppm: number; absorbance: number } | null,
  }
}

function renderChannels(choice: ChannelChoice, fit: Calibration | null) {
  const group = document.querySelector<HTMLDivElement>('#channels')!
  group.replaceChildren(channelButton('auto', 'Auto', choice === 'auto', false))
  for (const channel of CHANNELS) {
    const channelFit = fit?.channels[channel]
    const label = channelFit
      ? `${CHANNEL_LABEL[channel]} ${channelFit.r2.toFixed(3)}`
      : CHANNEL_LABEL[channel]
    group.append(
      channelButton(channel, label, choice === channel, fit?.chosen.channel === channel),
    )
  }
}

function channelButton(channel: string, label: string, pressed: boolean, inUse: boolean) {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.channel = channel
  button.textContent = label
  button.setAttribute('aria-pressed', String(pressed))
  button.classList.toggle('in-use', inUse)
  return button
}

function renderStandards(model: ViewModel, channel: Channel | null) {
  const blankRow = document.querySelector<HTMLDivElement>('#blank-row')!
  blankRow.replaceChildren()
  if (model.blank) {
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.background = cssColor(model.blank.srgb)
    const label = document.createElement('span')
    label.textContent = 'Blank captured'
    blankRow.append(swatch, label)
  } else {
    blankRow.textContent = 'No blank yet'
  }

  const list = document.querySelector<HTMLUListElement>('#standards')!
  list.replaceChildren()
  const ordered = [...model.standards].sort((left, right) => left.ppm - right.ppm)
  for (const standard of ordered) {
    const item = document.createElement('li')
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.background = cssColor(standard.srgb)
    const name = document.createElement('span')
    name.textContent = `${formatPpm(standard.ppm)} ppm`
    const absorbance = document.createElement('span')
    absorbance.className = 'absorbance'
    if (model.blank && channel) {
      const value = absorbanceChannels(standard.linear, model.blank.linear)[channel]
      absorbance.textContent = value === null ? 'No light' : `A ${formatAbsorbance(value)}`
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.dataset.remove = standard.id
    remove.textContent = 'Remove'
    item.append(swatch, name, absorbance, remove)
    list.append(item)
  }
}

function chartPoints(model: ViewModel, fit: ChannelFit | null) {
  if (!model.blank || !fit) return []
  const points: { ppm: number; absorbance: number }[] = []
  for (const standard of model.standards) {
    const absorbance = absorbanceChannels(standard.linear, model.blank.linear)[fit.channel]
    if (absorbance !== null) points.push({ ppm: standard.ppm, absorbance })
  }
  return points
}

function ppmRange(standards: Standard[]) {
  const values = standards.map((standard) => standard.ppm)
  const min = Math.min(...values)
  const max = Math.max(...values)
  return { min, max, span: Math.max(max - min, 0) }
}

function paintSwatch(node: HTMLElement, color: RGB | null) {
  node.hidden = !color
  if (color) node.style.background = cssColor(color)
}

function unit(label: string) {
  const node = document.createElement('span')
  node.textContent = label
  return node
}
