import './style.css'
import { registerSW } from 'virtual:pwa-register'
import {
  cameraErrorText,
  inspectLight,
  openCamera,
  sampleCenter,
  setLightLock,
  supportsManual,
  type LightLock,
} from './camera.ts'
import { evaluateSample } from './reading.ts'
import { render } from './view.ts'
import {
  addAnalysis,
  deleteAnalysis,
  deleteCurve,
  EMPTY_SESSION,
  loadLibrary,
  loadSession,
  saveLibrary,
  saveSession,
  upsertCurve,
  type AnalysisRecord,
  type CalibrationRecord,
  type Library,
  type SampleRecord,
  type SavedSession,
} from './storage.ts'
import type { ChannelChoice } from './types.ts'

const SCREEN_CURVE = 'screen'

let session: SavedSession = loadSession()
let library: Library = loadLibrary()
let lock: LightLock | null = null
let manualAvailable = false
let track: MediaStreamTrack | null = null
let cameraReady = false
let cameraError = ''
let busy = false
let notice = ''

const video = document.querySelector<HTMLVideoElement>('#camera')!

function publish() {
  const lightLocked = lock?.exposure === 'locked' || lock?.whiteBalance === 'locked' || lock?.focus === 'locked'
  render({
    blank: session.blank,
    standards: session.standards,
    channel: session.channel,
    sample: session.sample,
    calibrationId: session.calibrationId,
    calibrationName: session.calibrationName,
    analysisCurveId: session.analysisCurveId,
    curves: library.curves,
    analyses: library.analyses,
    lock,
    cameraReady,
    cameraError,
    canLockLight: manualAvailable,
    lightLocked,
    busy,
    notice,
  })
  saveSession(session)
  saveLibrary(library)
}

function persist(next: SavedSession) {
  session = next
  publish()
}

async function capture(label: string): Promise<SampleRecord | null> {
  if (!cameraReady || busy) return null
  busy = true
  notice = label
  publish()
  try {
    const patch = await sampleCenter(video)
    notice = ''
    return { srgb: patch.srgb, linear: patch.linear }
  } catch (error) {
    notice = error instanceof Error ? error.message : 'The capture failed.'
    return null
  } finally {
    busy = false
    publish()
  }
}

document.querySelector('#camera-toggle')!.addEventListener('click', async () => {
  if (busy) return
  if (cameraReady) {
    stopCamera()
    notice = ''
    publish()
    return
  }
  await startCamera()
})

document.querySelector('#lock')!.addEventListener('click', async () => {
  if (!track || busy) return
  const locking = !(lock?.exposure === 'locked' || lock?.whiteBalance === 'locked')
  busy = true
  notice = locking ? 'Locking the camera…' : 'Returning the camera to auto…'
  publish()
  try {
    lock = await setLightLock(track, locking)
    notice = ''
  } catch (error) {
    notice = error instanceof Error ? error.message : 'The camera lock failed.'
  } finally {
    busy = false
    publish()
  }
})

document.querySelector('#capture-blank')!.addEventListener('click', async () => {
  const sample = await capture('Averaging the blank…')
  if (!sample) return
  persist({ ...session, blank: sample })
  notice = 'Blank saved. Standards are referenced to this solvent.'
  publish()
})

document.querySelector<HTMLFormElement>('#standard-form')!.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!session.blank) {
    notice = 'Capture the clear-solvent blank first.'
    publish()
    return
  }
  const input = document.querySelector<HTMLInputElement>('#ppm')!
  const ppm = Number(input.value)
  if (!Number.isFinite(ppm) || ppm < 0) {
    notice = 'Enter a ppm of zero or greater.'
    publish()
    return
  }
  const sample = await capture(`Averaging the ${ppm} ppm standard…`)
  if (!sample) return
  persist({
    ...session,
    standards: [...session.standards, { id: crypto.randomUUID(), ppm, ...sample }],
  })
  input.value = ''
})

document.querySelector('#measure')!.addEventListener('click', async () => {
  const sample = await capture('Averaging the sample…')
  if (!sample) return
  const choice = await askCurve()
  if (!choice) {
    notice = 'The measurement was not saved. Select a calibration curve to analyze the sample.'
    publish()
    return
  }
  const curve = choice === SCREEN_CURVE ? await saveCurrentCurve() : findCurve(choice)
  if (!curve) {
    if (!notice) {
      notice =
        choice === SCREEN_CURVE
          ? 'The measurement was not saved. Name the curve on screen to use it.'
          : 'That calibration curve is no longer available.'
      publish()
    }
    return
  }
  if (!applyAnalysisCurve(curve, sample)) {
    notice = 'The measurement was not saved.'
    publish()
    return
  }
  const sampleName = await askName('Name this sample analysis', '', 'For example, tank 3')
  if (!sampleName) {
    notice = 'The reading is on screen. Name it to add it to the history.'
    publish()
    return
  }
  const evaluation = evaluateSample(session.blank, session.standards, session.channel, sample)
  const analysis: AnalysisRecord = {
    id: crypto.randomUUID(),
    name: sampleName,
    createdAt: Date.now(),
    calibrationId: curve.id,
    calibrationName: curve.name,
    channel: evaluation.channel ?? 'b',
    ppm: evaluation.ppm,
    absorbance: evaluation.absorbance,
    srgb: sample.srgb,
    linear: sample.linear,
    hueStatus: evaluation.hue?.status ?? null,
    note: evaluation.note,
  }
  library = addAnalysis(library, analysis)
  notice = `Stored “${sampleName}” with “${curve.name}”.`
  publish()
})

document.querySelector('#save-curve')!.addEventListener('click', async () => {
  if (busy) return
  const saved = await saveCurrentCurve()
  if (saved) {
    notice = `Saved “${saved.name}”.`
    publish()
  }
})

document.querySelector('#channels')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  const choice = button?.dataset.channel
  if (choice !== 'auto' && choice !== 'r' && choice !== 'g' && choice !== 'b') return
  persist({ ...session, channel: choice satisfies ChannelChoice })
})

document.querySelector('#standards')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  const id = button?.dataset.remove
  if (!id) return
  persist({ ...session, standards: session.standards.filter((standard) => standard.id !== id) })
})

document.querySelector('#curves')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  if (!button) return
  if (button.dataset.editCurve) openCurve(button.dataset.editCurve)
  if (button.dataset.deleteCurve) removeCurve(button.dataset.deleteCurve)
})

document.querySelector('#analyses')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button')
  const id = button?.dataset.deleteAnalysis
  if (!id) return
  const analysis = library.analyses.find((item) => item.id === id)
  if (!analysis) return
  if (!confirm(`Delete the analysis “${analysis.name}”?`)) return
  library = deleteAnalysis(library, id)
  notice = `Deleted “${analysis.name}”.`
  publish()
})

document.querySelector('#name-cancel')!.addEventListener('click', () => {
  document.querySelector<HTMLDialogElement>('#name-dialog')!.close()
})

document.querySelector('#curve-cancel')!.addEventListener('click', () => {
  document.querySelector<HTMLDialogElement>('#curve-dialog')!.close()
})

document.querySelector('#clear')!.addEventListener('click', () => {
  if (!session.blank && session.standards.length === 0 && !session.sample) return
  if (!confirm('Clear the curve on screen? Saved curves and analyses stay in the history.')) return
  notice = ''
  persist({ ...EMPTY_SESSION, analysisCurveId: session.analysisCurveId })
})

registerInstallPrompt()
publish()

if (import.meta.hot) {
  import.meta.hot.dispose(() => stopCamera())
}

async function startCamera() {
  if (cameraReady || busy) return
  busy = true
  cameraError = ''
  notice = 'Starting the camera…'
  publish()
  try {
    const stream = await openCamera(video)
    track = stream.getVideoTracks()[0] ?? null
    cameraReady = true
    manualAvailable = track ? supportsManual(track) : false
    lock = track ? inspectLight(track) : null
    notice = ''
  } catch (error) {
    stopCamera()
    cameraError = cameraErrorText(error)
    notice = ''
  } finally {
    busy = false
    publish()
  }
}

function stopCamera() {
  const stream = video.srcObject
  if (stream instanceof MediaStream) {
    for (const mediaTrack of stream.getTracks()) mediaTrack.stop()
  }
  video.srcObject = null
  track?.stop()
  track = null
  cameraReady = false
  manualAvailable = false
  lock = null
}

async function saveCurrentCurve(): Promise<CalibrationRecord | null> {
  if (!session.blank || session.standards.length < 2) {
    notice = 'Add a blank and at least two standards before saving the curve.'
    publish()
    return null
  }
  const blank = session.blank
  const standards = session.standards
  const name = await askName(
    session.calibrationId ? 'Save this calibration curve' : 'Name this calibration curve',
    session.calibrationName,
    'For example, diesel blend',
  )
  if (!name) return null
  const existing = library.curves.find((curve) => curve.id === session.calibrationId)
  const record: CalibrationRecord = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    blank: structuredClone(blank),
    standards: structuredClone(standards),
    channel: session.channel,
  }
  library = upsertCurve(library, record)
  session = { ...session, calibrationId: record.id, calibrationName: record.name }
  publish()
  return record
}

function openCurve(id: string) {
  const curve = library.curves.find((item) => item.id === id)
  if (!curve) return
  if (session.calibrationId === curve.id && !curveIsDirty()) {
    notice = `“${curve.name}” is already on screen.`
    publish()
    return
  }
  const switching = session.calibrationId !== curve.id
  const unsaved = curveIsDirty() || Boolean(session.sample)
  if (switching && hasWorkingCurve() && unsaved) {
    const replace = confirm(
      `Replace the curve on screen with “${curve.name}”? Save first if you want to keep the current edits.`,
    )
    if (!replace) return
  }
  const copy = structuredClone(curve)
  notice = `Editing “${copy.name}”.`
  persist({
    blank: copy.blank,
    standards: copy.standards,
    channel: copy.channel,
    sample: null,
    calibrationId: copy.id,
    calibrationName: copy.name,
    analysisCurveId: session.analysisCurveId,
  })
}

function removeCurve(id: string) {
  const curve = library.curves.find((item) => item.id === id)
  if (!curve) return
  if (!confirm(`Delete the calibration curve “${curve.name}”? Saved analyses stay in the history.`)) return
  library = deleteCurve(library, id)
  session = {
    ...session,
    calibrationId: session.calibrationId === id ? null : session.calibrationId,
    calibrationName: session.calibrationId === id ? '' : session.calibrationName,
    analysisCurveId: session.analysisCurveId === id ? null : session.analysisCurveId,
  }
  notice = `Deleted “${curve.name}”.`
  publish()
}

function curveIsDirty() {
  if (!session.calibrationId) return true
  const saved = library.curves.find((curve) => curve.id === session.calibrationId)
  if (!saved) return true
  return (
    saved.name !== session.calibrationName ||
    saved.channel !== session.channel ||
    JSON.stringify(saved.blank) !== JSON.stringify(session.blank) ||
    JSON.stringify(saved.standards) !== JSON.stringify(session.standards)
  )
}

function hasWorkingCurve() {
  return Boolean(session.blank) || session.standards.length > 0
}

function findCurve(id: string): CalibrationRecord | null {
  return library.curves.find((curve) => curve.id === id) ?? null
}

function screenCurveReady() {
  return Boolean(session.blank) && session.standards.length >= 2
}

function applyAnalysisCurve(curve: CalibrationRecord, sample: SampleRecord): boolean {
  const already = session.calibrationId === curve.id && !curveIsDirty()
  if (!already && hasWorkingCurve()) {
    const replace = confirm(`Use “${curve.name}” for this sample? The curve on screen will be replaced.`)
    if (!replace) return false
  }
  const copy = structuredClone(curve)
  session = {
    blank: copy.blank,
    standards: copy.standards,
    channel: copy.channel,
    sample,
    calibrationId: copy.id,
    calibrationName: copy.name,
    analysisCurveId: copy.id,
  }
  publish()
  return true
}

function askCurve(): Promise<string | null> {
  const dialog = document.querySelector<HTMLDialogElement>('#curve-dialog')!
  const form = document.querySelector<HTMLFormElement>('#curve-form')!
  const choices = document.querySelector<HTMLDivElement>('#curve-choices')!
  const note = document.querySelector('#curve-dialog-note')!
  const use = document.querySelector<HTMLButtonElement>('#curve-use')!
  choices.replaceChildren()

  const saved = [...library.curves].sort((left, right) => right.updatedAt - left.updatedAt)
  const offerScreen = screenCurveReady() && (!session.calibrationId || curveIsDirty())
  const remembered = saved.find((curve) => curve.id === session.analysisCurveId)?.id ?? null
  const preferred = remembered ?? saved[0]?.id ?? (offerScreen ? SCREEN_CURVE : null)

  note.textContent = preferred
    ? 'This choice stays selected for the next sample until you choose a different curve.'
    : 'Save a calibration curve with a blank and at least two standards first.'
  use.hidden = !preferred

  if (offerScreen) {
    const title = session.calibrationName
      ? `“${session.calibrationName}” on screen`
      : 'Curve on screen'
    choices.append(curveOption(SCREEN_CURVE, title, 'Unsaved changes', preferred === SCREEN_CURVE))
  }
  for (const curve of saved) {
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      curve.updatedAt,
    )
    choices.append(
      curveOption(
        curve.id,
        curve.name,
        `${curve.standards.length} standards · ${when}`,
        preferred === curve.id,
      ),
    )
  }

  dialog.showModal()
  const checked = choices.querySelector<HTMLInputElement>('input:checked')
  if (checked) checked.focus()
  else document.querySelector<HTMLButtonElement>('#curve-cancel')!.focus()

  return new Promise((resolve) => {
    const finish = (id: string | null) => {
      form.removeEventListener('submit', onSubmit)
      dialog.removeEventListener('close', onClose)
      resolve(id)
    }
    const onClose = () => finish(null)
    const onSubmit = (event: Event) => {
      event.preventDefault()
      const selected = new FormData(form).get('calibration-curve')
      if (typeof selected !== 'string' || !selected) return
      dialog.removeEventListener('close', onClose)
      dialog.close()
      finish(selected)
    }
    form.addEventListener('submit', onSubmit)
    dialog.addEventListener('close', onClose)
  })
}

function curveOption(id: string, title: string, detail: string, checked: boolean) {
  const label = document.createElement('label')
  label.className = 'curve-choice'
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = 'calibration-curve'
  input.value = id
  input.checked = checked
  input.required = true
  const text = document.createElement('span')
  const name = document.createElement('strong')
  name.textContent = title
  const meta = document.createElement('span')
  meta.textContent = detail
  text.append(name, meta)
  label.append(input, text)
  return label
}

function askName(title: string, initial: string, placeholder: string): Promise<string | null> {
  const dialog = document.querySelector<HTMLDialogElement>('#name-dialog')!
  const form = document.querySelector<HTMLFormElement>('#name-form')!
  const input = document.querySelector<HTMLInputElement>('#name-input')!
  document.querySelector('#name-title')!.textContent = title
  input.value = initial
  input.placeholder = placeholder
  dialog.showModal()
  input.focus()
  input.select()
  return new Promise((resolve) => {
    const finish = (name: string | null) => {
      form.removeEventListener('submit', onSubmit)
      dialog.removeEventListener('close', onClose)
      resolve(name)
    }
    const onClose = () => finish(null)
    const onSubmit = (event: Event) => {
      event.preventDefault()
      const name = input.value.trim()
      if (!name) {
        input.setCustomValidity('Enter a name.')
        input.reportValidity()
        input.setCustomValidity('')
        return
      }
      dialog.removeEventListener('close', onClose)
      dialog.close()
      finish(name)
    }
    form.addEventListener('submit', onSubmit)
    dialog.addEventListener('close', onClose)
  })
}

function registerInstallPrompt() {
  const install = document.querySelector<HTMLButtonElement>('#install')!
  let deferred: BeforeInstallPromptEvent | null = null
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    install.hidden = false
  })
  install.addEventListener('click', async () => {
    if (!deferred) return
    await deferred.prompt()
    deferred = null
    install.hidden = true
  })
  registerSW({ immediate: false })
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}
