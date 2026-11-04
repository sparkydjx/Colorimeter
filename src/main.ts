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
import { render } from './view.ts'
import { EMPTY_SESSION, loadSession, saveSession, type SampleRecord, type SavedSession } from './storage.ts'
import type { ChannelChoice } from './types.ts'

let session: SavedSession = loadSession()
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
    lock,
    cameraReady,
    cameraError,
    canLockLight: manualAvailable,
    lightLocked,
    busy,
    notice,
  })
  saveSession(session)
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
  if (!session.blank || session.standards.length < 2) {
    notice = 'Capture a blank and at least two standards before measuring a sample.'
    publish()
    return
  }
  const sample = await capture('Averaging the sample…')
  if (!sample) return
  persist({ ...session, sample })
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

document.querySelector('#clear')!.addEventListener('click', () => {
  if (!session.blank && session.standards.length === 0 && !session.sample) return
  if (!confirm('Clear the blank, standards, and last reading?')) return
  notice = ''
  persist({ ...EMPTY_SESSION })
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
