import type { Blank, ChannelChoice, RGB, Standard } from './types.ts'

const KEY = 'colorimeter.calibration.v1'

export type SampleRecord = {
  srgb: RGB
  linear: RGB
}

export type SavedSession = {
  blank: Blank | null
  standards: Standard[]
  channel: ChannelChoice
  sample: SampleRecord | null
}

export const EMPTY_SESSION: SavedSession = {
  blank: null,
  standards: [],
  channel: 'auto',
  sample: null,
}

export function loadSession(): SavedSession {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...EMPTY_SESSION }
    return parseSession(JSON.parse(raw))
  } catch {
    return { ...EMPTY_SESSION }
  }
}

export function saveSession(session: SavedSession): void {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export function parseSession(value: unknown): SavedSession {
  if (!value || typeof value !== 'object') return { ...EMPTY_SESSION }
  const record = value as Partial<SavedSession>
  return {
    blank: parseBlank(record.blank),
    standards: Array.isArray(record.standards)
      ? record.standards.flatMap((item) => {
          const standard = parseStandard(item)
          return standard ? [standard] : []
        })
      : [],
    channel: parseChannel(record.channel),
    sample: parseSample(record.sample),
  }
}

function parseBlank(value: unknown): Blank | null {
  if (!value || typeof value !== 'object') return null
  const blank = value as Partial<Blank>
  if (!isRgb(blank.srgb) || !isRgb(blank.linear)) return null
  return { srgb: blank.srgb, linear: blank.linear }
}

function parseStandard(value: unknown): Standard | null {
  if (!value || typeof value !== 'object') return null
  const standard = value as Partial<Standard>
  if (typeof standard.id !== 'string' || !standard.id) return null
  if (typeof standard.ppm !== 'number' || !Number.isFinite(standard.ppm) || standard.ppm < 0) {
    return null
  }
  if (!isRgb(standard.srgb) || !isRgb(standard.linear)) return null
  return { id: standard.id, ppm: standard.ppm, srgb: standard.srgb, linear: standard.linear }
}

function parseSample(value: unknown): SampleRecord | null {
  if (!value || typeof value !== 'object') return null
  const sample = value as Partial<SampleRecord>
  if (!isRgb(sample.srgb) || !isRgb(sample.linear)) return null
  return { srgb: sample.srgb, linear: sample.linear }
}

function parseChannel(value: unknown): ChannelChoice {
  return value === 'r' || value === 'g' || value === 'b' || value === 'auto' ? value : 'auto'
}

function isRgb(value: unknown): value is RGB {
  if (!value || typeof value !== 'object') return false
  const color = value as Partial<RGB>
  return [color.r, color.g, color.b].every(
    (channel) => typeof channel === 'number' && Number.isFinite(channel),
  )
}
