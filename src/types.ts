export type RGB = { r: number; g: number; b: number }

export type Channel = 'r' | 'g' | 'b'

export type ChannelChoice = Channel | 'auto'

export const CHANNELS: Channel[] = ['r', 'g', 'b']

export const CHANNEL_LABEL: Record<Channel, string> = {
  r: 'Red',
  g: 'Green',
  b: 'Blue',
}

export type Patch = {
  /** Mean camera color, 0–255, after averaging in linear light. */
  srgb: RGB
  /** Mean intensity, 0–1, with the sRGB transfer function removed. */
  linear: RGB
}

export type Standard = {
  id: string
  ppm: number
  srgb: RGB
  linear: RGB
}

export type Blank = {
  srgb: RGB
  linear: RGB
}
