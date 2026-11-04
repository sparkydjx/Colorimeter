import { describe, expect, it } from 'vitest'
import { fitCalibration, fitEquation, ppmAt } from '../src/calibration.ts'
import {
  absorbance,
  checkHue,
  linearToSrgbByte,
  srgbByteToLinear,
} from '../src/colorimetry.ts'
import {
  addAnalysis,
  deleteCurve,
  parseLibrary,
  parseSession,
  upsertCurve,
  type AnalysisRecord,
  type CalibrationRecord,
} from '../src/storage.ts'

describe('linear light', () => {
  it('maps the ends of sRGB', () => {
    expect(srgbByteToLinear(0)).toBe(0)
    expect(srgbByteToLinear(255)).toBeCloseTo(1)
  })

  it('round-trips a mid gray through the sRGB curve', () => {
    expect(linearToSrgbByte(srgbByteToLinear(128))).toBe(128)
  })
})

describe('absorbance', () => {
  it('follows the blank-to-sample ratio', () => {
    expect(absorbance(0.4, 0.8)).toBeCloseTo(Math.log10(2))
  })

  it('rejects a blank with no light', () => {
    expect(absorbance(0.2, 0)).toBeNull()
  })
})

describe('calibration', () => {
  it('reads ppm from the straightest rising channel', () => {
    const fit = fitCalibration(
      [
        { ppm: 0, absorbance: { r: 0.02, g: 0.01, b: 0 } },
        { ppm: 10, absorbance: { r: 0.01, g: 0.04, b: 0.1 } },
        { ppm: 20, absorbance: { r: 0.03, g: 0.09, b: 0.2 } },
        { ppm: 30, absorbance: { r: 0.02, g: 0.13, b: 0.3 } },
      ],
      'auto',
    )

    expect(fit?.chosen.channel).toBe('b')
    expect(fit?.chosen.model).toBe('linear')
    expect(ppmAt(fit!.chosen, 0.2, { min: 0, max: 30 })).toBeCloseTo(20, 5)
  })

  it('follows a bend with a quadratic', () => {
    const concentrations = [0, 25, 50, 75, 100]
    const fit = fitCalibration(
      concentrations.map((ppm) => ({
        ppm,
        absorbance: { r: 0, g: 0, b: 0.02 * ppm - 0.00008 * ppm * ppm },
      })),
      'auto',
    )

    expect(fit?.chosen.model).toBe('quadratic')
    expect(ppmAt(fit!.chosen, 0.8, { min: 0, max: 100 })).toBeCloseTo(50, 4)
  })

  it('keeps a two-point series on a straight line', () => {
    const fit = fitCalibration(
      [
        { ppm: 10, absorbance: { r: 0, g: 0, b: 0.1 } },
        { ppm: 20, absorbance: { r: 0, g: 0, b: 0.2 } },
      ],
      'auto',
    )

    expect(fit?.chosen.model).toBe('linear')
    expect(fitEquation(fit!.chosen)).toBe('A = 0.01 ppm')
    expect(fit?.summary).toContain('R² 1.000')
    expect(ppmAt(fit!.chosen, 0.15, { min: 10, max: 20 })).toBeCloseTo(15, 5)
  })

  it('returns no concentration for a flat channel', () => {
    const fit = fitCalibration(
      [
        { ppm: 10, absorbance: { r: 0.2, g: 0.2, b: 0.2 } },
        { ppm: 20, absorbance: { r: 0.2, g: 0.2, b: 0.2 } },
      ],
      'r',
    )

    expect(ppmAt(fit!.chosen, 0.2, { min: 10, max: 20 })).toBeNull()
  })
})

describe('hue', () => {
  it('flags a sample that is no longer the oil color', () => {
    const oils = [
      { r: 210, g: 160, b: 30 },
      { r: 190, g: 140, b: 20 },
    ]
    expect(checkHue({ r: 30, g: 80, b: 190 }, oils).status).toBe('shift')
  })

  it('skips the hue check when the sample is nearly colorless', () => {
    expect(checkHue({ r: 140, g: 140, b: 140 }, [{ r: 210, g: 160, b: 30 }]).status).toBe('faint')
  })
})

describe('saved calibration', () => {
  it('ignores a malformed session', () => {
    expect(parseSession({ blank: { srgb: { r: 1 } }, channel: 'nope', standards: [{}] })).toEqual({
      blank: null,
      standards: [],
      channel: 'auto',
      sample: null,
      calibrationId: null,
      calibrationName: '',
      analysisCurveId: null,
    })
  })
})

describe('history', () => {
  const color = { r: 1, g: 1, b: 1 }
  const curve: CalibrationRecord = {
    id: 'curve-1',
    name: 'Diesel blend',
    createdAt: 1,
    updatedAt: 1,
    blank: { srgb: color, linear: color },
    standards: [
      { id: 'a', ppm: 10, srgb: color, linear: color },
      { id: 'b', ppm: 20, srgb: color, linear: color },
    ],
    channel: 'auto',
  }
  const analysis: AnalysisRecord = {
    id: 'sample-1',
    name: 'Tank 3',
    createdAt: 2,
    calibrationId: 'curve-1',
    calibrationName: 'Diesel blend',
    channel: 'b',
    ppm: 12,
    absorbance: 0.2,
    srgb: color,
    linear: color,
    hueStatus: 'match',
    note: 'Hue matches the calibration oils.',
  }

  it('renames a saved curve and the analyses that use it', () => {
    const library = addAnalysis({ curves: [curve], analyses: [] }, analysis)
    const renamed = upsertCurve(library, { ...curve, name: 'Fresh diesel', updatedAt: 3 })
    expect(renamed.curves[0]?.name).toBe('Fresh diesel')
    expect(renamed.analyses[0]?.calibrationName).toBe('Fresh diesel')
  })

  it('keeps analyses when a curve is deleted', () => {
    const library = deleteCurve({ curves: [curve], analyses: [analysis] }, curve.id)
    expect(library.curves).toHaveLength(0)
    expect(library.analyses).toHaveLength(1)
  })

  it('drops a curve that cannot be edited', () => {
    expect(parseLibrary({ curves: [{ id: 'x', name: 'Broken' }], analyses: [analysis, { id: 'bad' }] })).toEqual({
      curves: [],
      analyses: [analysis],
    })
  })
})
