import type { HueStatus } from './colorimetry.ts'
import type { Blank, Channel, ChannelChoice, RGB, Standard } from './types.ts'

const SESSION_KEY = 'colorimeter.calibration.v1'
const LIBRARY_KEY = 'colorimeter.library.v1'

export type SampleRecord = {
  srgb: RGB
  linear: RGB
}

export type CalibrationRecord = {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  blank: Blank
  standards: Standard[]
  channel: ChannelChoice
}

export type AnalysisRecord = {
  id: string
  name: string
  createdAt: number
  calibrationId: string
  calibrationName: string
  channel: Channel
  ppm: number | null
  absorbance: number | null
  srgb: RGB
  linear: RGB
  hueStatus: HueStatus | null
  note: string
}

export type Library = {
  curves: CalibrationRecord[]
  analyses: AnalysisRecord[]
}

export const EMPTY_LIBRARY: Library = {
  curves: [],
  analyses: [],
}

export type SavedSession = {
  blank: Blank | null
  standards: Standard[]
  channel: ChannelChoice
  sample: SampleRecord | null
  calibrationId: string | null
  calibrationName: string
}

export const EMPTY_SESSION: SavedSession = {
  blank: null,
  standards: [],
  channel: 'auto',
  sample: null,
  calibrationId: null,
  calibrationName: '',
}

export function loadSession(): SavedSession {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return { ...EMPTY_SESSION }
    return parseSession(JSON.parse(raw))
  } catch {
    return { ...EMPTY_SESSION }
  }
}

export function saveSession(session: SavedSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}

export function loadLibrary(): Library {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY)
    if (!raw) return { curves: [], analyses: [] }
    return parseLibrary(JSON.parse(raw))
  } catch {
    return { curves: [], analyses: [] }
  }
}

export function saveLibrary(library: Library): void {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(library))
}

export function upsertCurve(library: Library, curve: CalibrationRecord): Library {
  const curves = library.curves.some((item) => item.id === curve.id)
    ? library.curves.map((item) => (item.id === curve.id ? curve : item))
    : [curve, ...library.curves]
  const analyses = library.analyses.map((analysis) =>
    analysis.calibrationId === curve.id
      ? { ...analysis, calibrationName: curve.name }
      : analysis,
  )
  return { curves, analyses }
}

export function deleteCurve(library: Library, id: string): Library {
  return { ...library, curves: library.curves.filter((curve) => curve.id !== id) }
}

export function addAnalysis(library: Library, analysis: AnalysisRecord): Library {
  return { ...library, analyses: [analysis, ...library.analyses] }
}

export function deleteAnalysis(library: Library, id: string): Library {
  return { ...library, analyses: library.analyses.filter((analysis) => analysis.id !== id) }
}

export function parseLibrary(value: unknown): Library {
  if (!value || typeof value !== 'object') return { curves: [], analyses: [] }
  const record = value as Partial<Library>
  return {
    curves: Array.isArray(record.curves)
      ? record.curves.flatMap((item) => {
          const curve = parseCurve(item)
          return curve ? [curve] : []
        })
      : [],
    analyses: Array.isArray(record.analyses)
      ? record.analyses.flatMap((item) => {
          const analysis = parseAnalysis(item)
          return analysis ? [analysis] : []
        })
      : [],
  }
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
    calibrationId: typeof record.calibrationId === 'string' && record.calibrationId ? record.calibrationId : null,
    calibrationName: typeof record.calibrationName === 'string' ? record.calibrationName : '',
  }
}

function parseCurve(value: unknown): CalibrationRecord | null {
  if (!value || typeof value !== 'object') return null
  const curve = value as Partial<CalibrationRecord>
  if (typeof curve.id !== 'string' || !curve.id) return null
  if (typeof curve.name !== 'string' || !curve.name.trim()) return null
  const blank = parseBlank(curve.blank)
  if (!blank) return null
  const standards = Array.isArray(curve.standards)
    ? curve.standards.flatMap((item) => {
        const standard = parseStandard(item)
        return standard ? [standard] : []
      })
    : []
  if (standards.length < 2) return null
  return {
    id: curve.id,
    name: curve.name.trim(),
    createdAt: timeOrNow(curve.createdAt),
    updatedAt: timeOrNow(curve.updatedAt),
    blank,
    standards,
    channel: parseChannel(curve.channel),
  }
}

function parseAnalysis(value: unknown): AnalysisRecord | null {
  if (!value || typeof value !== 'object') return null
  const analysis = value as Partial<AnalysisRecord>
  if (typeof analysis.id !== 'string' || !analysis.id) return null
  if (typeof analysis.name !== 'string' || !analysis.name.trim()) return null
  if (typeof analysis.calibrationId !== 'string' || !analysis.calibrationId) return null
  if (typeof analysis.calibrationName !== 'string') return null
  if (!isRgb(analysis.srgb) || !isRgb(analysis.linear)) return null
  if (analysis.channel !== 'r' && analysis.channel !== 'g' && analysis.channel !== 'b') return null
  return {
    id: analysis.id,
    name: analysis.name.trim(),
    createdAt: timeOrNow(analysis.createdAt),
    calibrationId: analysis.calibrationId,
    calibrationName: analysis.calibrationName,
    channel: analysis.channel,
    ppm: finiteOrNull(analysis.ppm),
    absorbance: finiteOrNull(analysis.absorbance),
    srgb: analysis.srgb,
    linear: analysis.linear,
    hueStatus: parseHueStatus(analysis.hueStatus),
    note: typeof analysis.note === 'string' ? analysis.note : '',
  }
}

function timeOrNow(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseHueStatus(value: unknown): HueStatus | null {
  return value === 'match' || value === 'shift' || value === 'faint' || value === 'unready' ? value : null
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
