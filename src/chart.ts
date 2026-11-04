import { absorbanceAt, fitEquation, type ChannelFit } from './calibration.ts'
import { CHANNEL_LABEL } from './types.ts'

type ChartPoint = { ppm: number; absorbance: number }

const WIDTH = 420
const HEIGHT = 258
const PAD = { left: 44, right: 14, top: 54, bottom: 34 }

export function drawChart(
  svg: SVGSVGElement,
  fit: ChannelFit | null,
  points: ChartPoint[],
  unknown: ChartPoint | null,
): void {
  svg.replaceChildren()
  const label = fit
    ? `${fitEquation(fit)}. R squared ${fit.r2.toFixed(3)}. ${CHANNEL_LABEL[fit.channel]} channel.`
    : 'Calibration curve'
  svg.setAttribute('aria-label', label)
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)

  if (!points.length) {
    text(svg, WIDTH / 2, HEIGHT / 2, 'Standards will appear here', 'middle')
    return
  }

  if (fit) fitStats(svg, fit)

  const xs = points.map((point) => point.ppm)
  const ys = points.map((point) => point.absorbance)
  if (unknown) {
    xs.push(unknown.ppm)
    ys.push(unknown.absorbance)
  }
  if (fit) {
    const start = Math.min(...points.map((point) => point.ppm))
    const end = Math.max(...points.map((point) => point.ppm))
    ys.push(absorbanceAt(fit, start), absorbanceAt(fit, end))
  }

  const xMin = Math.min(0, ...xs)
  const xMax = Math.max(1, ...xs)
  const yMin = Math.min(0, ...ys)
  const yMax = Math.max(0.05, ...ys)
  const xSpan = xMax - xMin || 1
  const ySpan = yMax - yMin || 1
  const x0 = xMin - xSpan * 0.06
  const x1 = xMax + xSpan * 0.08
  const y0 = yMin - ySpan * 0.12
  const y1 = yMax + ySpan * 0.12

  const X = (ppm: number) =>
    PAD.left + ((ppm - x0) / (x1 - x0)) * (WIDTH - PAD.left - PAD.right)
  const Y = (absorbance: number) =>
    HEIGHT - PAD.bottom - ((absorbance - y0) / (y1 - y0)) * (HEIGHT - PAD.top - PAD.bottom)

  axis(svg, X(x0), Y(0), X(x1), Y(0))
  axis(svg, X(0), Y(y0), X(0), Y(y1))
  text(svg, WIDTH / 2, HEIGHT - 8, 'ppm', 'middle')
  text(svg, 12, PAD.top + 4, 'A', 'start')

  if (fit) {
    const start = x0
    const end = x1
    const steps = 48
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline')
    const coords: string[] = []
    for (let step = 0; step <= steps; step += 1) {
      const ppm = start + ((end - start) * step) / steps
      coords.push(`${X(ppm)},${Y(absorbanceAt(fit, ppm))}`)
    }
    line.setAttribute('points', coords.join(' '))
    line.setAttribute('class', 'fit-line')
    svg.append(line)
  }

  for (const point of points) {
    dot(svg, X(point.ppm), Y(point.absorbance), 'standard-dot')
  }
  if (unknown) dot(svg, X(unknown.ppm), Y(unknown.absorbance), 'sample-dot')
}

function axis(svg: SVGSVGElement, x1: number, y1: number, x2: number, y2: number) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
  line.setAttribute('x1', String(x1))
  line.setAttribute('y1', String(y1))
  line.setAttribute('x2', String(x2))
  line.setAttribute('y2', String(y2))
  line.setAttribute('class', 'axis')
  svg.append(line)
}

function dot(svg: SVGSVGElement, x: number, y: number, className: string) {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', String(x))
  circle.setAttribute('cy', String(y))
  circle.setAttribute('r', className === 'sample-dot' ? '5.5' : '4')
  circle.setAttribute('class', className)
  svg.append(circle)
}

function fitStats(svg: SVGSVGElement, fit: ChannelFit) {
  const equation = text(svg, 12, 18, fitEquation(fit), 'start', 'chart-equation')
  text(svg, 12, 36, `R² = ${fit.r2.toFixed(3)}`, 'start', 'chart-fit')
  const room = WIDTH - 24
  const width = equation.getBBox?.().width ?? 0
  if (width > room) {
    equation.setAttribute('font-size', String(Math.max(9, (13 * room) / width)))
  }
}

function text(
  svg: SVGSVGElement,
  x: number,
  y: number,
  value: string,
  anchor: string,
  className = 'chart-label',
) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'text')
  node.setAttribute('x', String(x))
  node.setAttribute('y', String(y))
  node.setAttribute('text-anchor', anchor)
  node.setAttribute('class', className)
  node.textContent = value
  svg.append(node)
  return node
}
