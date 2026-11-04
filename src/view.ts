import { formatAbsorbance, formatPpm, type Calibration, type ChannelFit } from './calibration.ts'
import { drawChart } from './chart.ts'
import { absorbanceChannels, cssColor } from './colorimetry.ts'
import { describeLock, type LightLock } from './camera.ts'
import { evaluateSample } from './reading.ts'
import type { AnalysisRecord, CalibrationRecord, SampleRecord } from './storage.ts'
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
  calibrationId: string | null
  calibrationName: string
  analysisCurveId: string | null
  curves: CalibrationRecord[]
  analyses: AnalysisRecord[]
  lock: LightLock | null
  cameraReady: boolean
  cameraError: string
  canLockLight: boolean
  lightLocked: boolean
  busy: boolean
  notice: string
}

export function render(model: ViewModel) {
  const reading = evaluateSample(model.blank, model.standards, model.channel, model.sample)
  const fit = reading.fit

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
  document.querySelector<HTMLButtonElement>('#measure')!.disabled = !ready
  document.querySelector<HTMLButtonElement>('#add-standard')!.disabled = !ready || !model.blank
  document.querySelector<HTMLInputElement>('#ppm')!.disabled = model.busy

  const readout = document.querySelector<HTMLElement>('#readout')!
  readout.classList.toggle('is-warning', reading.warning)
  const ppmValue = document.querySelector<HTMLParagraphElement>('#ppm-value')!
  ppmValue.textContent = ''
  if (reading.ppmLabel === null) {
    ppmValue.textContent = '—'
  } else {
    ppmValue.append(reading.ppmLabel, unit('ppm'))
  }
  document.querySelector('#readout-detail')!.textContent = reading.detail
  document.querySelector('#hue-note')!.textContent = reading.note
  paintSwatch(document.querySelector('#sample-swatch')!, model.sample?.srgb ?? null)
  const activeCurve = model.curves.find((curve) => curve.id === model.analysisCurveId)
  document.querySelector('#active-curve')!.textContent = activeCurve
    ? `Sample analyses use “${activeCurve.name}” until you select another curve.`
    : 'Select a calibration curve when you measure a sample.'

  const curveLabel = document.querySelector('#curve-label')!
  curveLabel.textContent = model.calibrationName
    ? model.calibrationName
    : 'Unsaved curve'
  const save = document.querySelector<HTMLButtonElement>('#save-curve')!
  save.textContent = model.calibrationId ? 'Save changes' : 'Save curve'
  save.disabled = model.busy || !model.blank || model.standards.length < 2

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

  renderCurves(model)
  renderAnalyses(model.analyses)
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

function renderCurves(model: ViewModel) {
  const list = document.querySelector<HTMLUListElement>('#curves')!
  list.replaceChildren()
  if (!model.curves.length) {
    list.append(emptyItem('Saved curves appear here.'))
    return
  }
  const ordered = [...model.curves].sort((left, right) => right.updatedAt - left.updatedAt)
  for (const curve of ordered) {
    const item = document.createElement('li')
    item.classList.toggle('is-open', curve.id === model.calibrationId)
    const text = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = curve.name
    const meta = document.createElement('p')
    const open = curve.id === model.calibrationId ? 'On screen · ' : ''
    meta.textContent = `${open}${curve.standards.length} standards · ${formatWhen(curve.updatedAt)}`
    text.append(title, meta)
    const actions = document.createElement('div')
    actions.className = 'record-actions'
    actions.append(recordButton('edit-curve', curve.id, 'Edit'), recordButton('delete-curve', curve.id, 'Delete'))
    item.append(text, actions)
    list.append(item)
  }
}

function renderAnalyses(analyses: AnalysisRecord[]) {
  const list = document.querySelector<HTMLUListElement>('#analyses')!
  list.replaceChildren()
  if (!analyses.length) {
    list.append(emptyItem('Named sample analyses appear here.'))
    return
  }
  const ordered = [...analyses].sort((left, right) => right.createdAt - left.createdAt)
  for (const analysis of ordered) {
    const item = document.createElement('li')
    const text = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = analysis.name
    const meta = document.createElement('p')
    const ppm = analysis.ppm === null ? 'No ppm' : `${formatPpm(analysis.ppm)} ppm`
    meta.textContent = `${ppm} · ${analysis.calibrationName} · ${formatWhen(analysis.createdAt)}`
    text.append(title, meta)
    if (analysis.note) {
      const note = document.createElement('p')
      note.className = 'record-note'
      note.textContent = analysis.note
      text.append(note)
    }
    const actions = document.createElement('div')
    actions.className = 'record-actions'
    actions.append(recordButton('delete-analysis', analysis.id, 'Delete'))
    item.append(text, actions)
    list.append(item)
  }
}

function emptyItem(message: string) {
  const item = document.createElement('li')
  item.className = 'empty'
  item.textContent = message
  return item
}

function recordButton(action: string, id: string, label: string) {
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset[action === 'edit-curve' ? 'editCurve' : action === 'delete-curve' ? 'deleteCurve' : 'deleteAnalysis'] = id
  button.textContent = label
  return button
}

function formatWhen(time: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
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
