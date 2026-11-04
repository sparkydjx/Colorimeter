import { patchFromLinear, srgbByteToLinear } from './colorimetry.ts'
import type { Patch } from './types.ts'

const SAMPLE_FRAMES = 12
const PATCH_FRACTION = 0.22
const PATCH_PIXELS = 48

export type LightLock = {
  exposure: 'locked' | 'auto' | 'unavailable'
  whiteBalance: 'locked' | 'auto' | 'unavailable'
  focus: 'locked' | 'auto' | 'unavailable'
}

type ModeCapability = 'exposureMode' | 'whiteBalanceMode' | 'focusMode'

type CameraCapabilities = MediaTrackCapabilities & {
  exposureMode?: string[]
  whiteBalanceMode?: string[]
  focusMode?: string[]
}

type CameraSettings = MediaTrackSettings & {
  exposureTime?: number
  colorTemperature?: number
  focusDistance?: number
}

type CameraConstraint = MediaTrackConstraintSet & {
  exposureMode?: string
  whiteBalanceMode?: string
  focusMode?: string
  exposureTime?: number
  colorTemperature?: number
  focusDistance?: number
}

export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot open a camera.')
  }

  const attempts: MediaStreamConstraints[] = [
    {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    },
    { audio: false, video: true },
  ]

  let lastError: unknown
  for (const constraints of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      video.srcObject = stream
      await video.play()
      if (!video.videoWidth) {
        await new Promise<void>((resolve) => {
          video.onloadedmetadata = () => resolve()
        })
      }
      return stream
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('The camera could not be opened.')
}

export function cameraErrorText(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Camera permission is blocked. Allow the camera, then reload.'
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No camera was found on this device.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'The camera could not be opened.'
}

export async function setLightLock(track: MediaStreamTrack, lock: boolean): Promise<LightLock> {
  const caps = (track.getCapabilities?.() ?? {}) as CameraCapabilities
  const settings = (track.getSettings?.() ?? {}) as CameraSettings
  const [exposure, whiteBalance, focus] = await Promise.all([
    applyMode(
      track,
      'exposureMode',
      caps.exposureMode,
      lock,
      typeof settings.exposureTime === 'number' ? { exposureTime: settings.exposureTime } : {},
    ),
    applyMode(
      track,
      'whiteBalanceMode',
      caps.whiteBalanceMode,
      lock,
      typeof settings.colorTemperature === 'number'
        ? { colorTemperature: settings.colorTemperature }
        : {},
    ),
    applyMode(
      track,
      'focusMode',
      caps.focusMode,
      lock,
      typeof settings.focusDistance === 'number' ? { focusDistance: settings.focusDistance } : {},
    ),
  ])
  return { exposure, whiteBalance, focus }
}

export function describeLock(lock: LightLock | null): string {
  if (!lock) return 'Lock the light once the preview looks even, then capture the blank.'
  const held = [
    lock.exposure === 'locked' ? 'Exposure' : '',
    lock.whiteBalance === 'locked' ? 'white balance' : '',
    lock.focus === 'locked' ? 'focus' : '',
  ].filter(Boolean)
  const steady = 'Keep the lamp and phone still between the blank, the standards, and the sample.'
  if (!held.length && lock.exposure !== 'auto' && lock.whiteBalance !== 'auto') {
    return `This camera cannot lock exposure or white balance. ${steady}`
  }
  if (!held.length) return `Exposure and white balance are still automatic. ${steady}`
  const lead = `${held.join(' and ')} locked.`
  return lock.exposure === 'locked' && lock.whiteBalance === 'locked' ? lead : `${lead} ${steady}`
}

/** Reads what the camera can lock. Does not change the camera. */
export function inspectLight(track: MediaStreamTrack): LightLock {
  const caps = (track.getCapabilities?.() ?? {}) as CameraCapabilities
  return {
    exposure: manualOrUnavailable(caps.exposureMode),
    whiteBalance: manualOrUnavailable(caps.whiteBalanceMode),
    focus: manualOrUnavailable(caps.focusMode),
  }
}

export function supportsManual(track: MediaStreamTrack): boolean {
  const light = inspectLight(track)
  return light.exposure === 'auto' || light.whiteBalance === 'auto' || light.focus === 'auto'
}

function manualOrUnavailable(modes: string[] | undefined): LightLock['exposure'] {
  return modes?.includes('manual') ? 'auto' : 'unavailable'
}

async function applyMode(
  track: MediaStreamTrack,
  key: ModeCapability,
  supported: string[] | undefined,
  lock: boolean,
  extras: CameraConstraint,
): Promise<LightLock['exposure']> {
  if (!supported?.length) return 'unavailable'
  const mode = lock && supported.includes('manual') ? 'manual' : 'continuous'
  if (!supported.includes(mode)) return supported.includes('continuous') ? 'auto' : 'unavailable'
  const constraint = { [key]: mode, ...(mode === 'manual' ? extras : {}) } as CameraConstraint
  try {
    await track.applyConstraints({ advanced: [constraint] })
    return mode === 'manual' ? 'locked' : 'auto'
  } catch {
    if (mode === 'manual') {
      try {
        await track.applyConstraints({ advanced: [{ [key]: 'manual' } as MediaTrackConstraintSet] })
        return 'locked'
      } catch {
        return 'auto'
      }
    }
    return 'auto'
  }
}

export async function sampleCenter(video: HTMLVideoElement): Promise<Patch> {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('The camera is not ready yet.')
  }

  const canvas = document.createElement('canvas')
  canvas.width = PATCH_PIXELS
  canvas.height = PATCH_PIXELS
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Could not read pixels from the camera.')

  const crop = Math.max(8, Math.round(Math.min(video.videoWidth, video.videoHeight) * PATCH_FRACTION))
  const sx = Math.round((video.videoWidth - crop) / 2)
  const sy = Math.round((video.videoHeight - crop) / 2)
  const sums = { r: 0, g: 0, b: 0 }
  let count = 0

  for (let frame = 0; frame < SAMPLE_FRAMES; frame += 1) {
    await nextVideoFrame(video)
    context.drawImage(video, sx, sy, crop, crop, 0, 0, PATCH_PIXELS, PATCH_PIXELS)
    const pixels = context.getImageData(0, 0, PATCH_PIXELS, PATCH_PIXELS).data
    for (let index = 0; index < pixels.length; index += 4) {
      sums.r += srgbByteToLinear(pixels[index])
      sums.g += srgbByteToLinear(pixels[index + 1])
      sums.b += srgbByteToLinear(pixels[index + 2])
      count += 1
    }
  }

  return patchFromLinear(sums, count)
}

function nextVideoFrame(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => resolve())
    } else {
      requestAnimationFrame(() => resolve())
    }
  })
}
