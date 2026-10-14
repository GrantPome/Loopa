import type { GridDivision, TimeSignature } from '@/types'

/** 音名表（升号记法） */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** 钢琴卷帘纵向音高范围：C0 ~ C7 */
export const MIN_MIDI = 12
export const MAX_MIDI = 96

/** 黑键音级（相对 C 的半音偏移） */
const BLACK_KEY_OFFSETS = [1, 3, 6, 8, 10]

/** MIDI 音号 -> 音名，例如 60 -> "C4" */
export function midiToNoteName(midi: number): string {
  const safe = Math.max(0, Math.min(127, Math.round(midi)))
  const name = NOTE_NAMES[((safe % 12) + 12) % 12]
  const octave = Math.floor(safe / 12) - 1
  return `${name}${octave}`
}

/** 是否为黑键 */
export function isBlackKey(midi: number): boolean {
  return BLACK_KEY_OFFSETS.includes(((midi % 12) + 12) % 12)
}

/** 数值夹取 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 生成唯一 ID（无需引入额外依赖） */
let uidSeed = 0
export function uid(prefix = 'id'): string {
  uidSeed += 1
  return `${prefix}_${Date.now().toString(36)}_${uidSeed.toString(36)}`
}

/** 各拍号对应的小节拍数（拍的单位统一为四分音符） */
const BEATS_PER_BAR: Record<TimeSignature, number> = {
  '2/4': 2,
  '3/4': 3,
  '4/4': 4,
  '5/4': 5,
  '6/8': 3,
  '7/8': 3.5,
  '9/8': 4.5,
  '12/8': 6
}

/** 拍号 -> 每小节拍数（四分音符为 1 拍；如 6/8 = 3、7/8 = 3.5） */
export function beatsPerBarOf(ts: TimeSignature): number {
  return BEATS_PER_BAR[ts] ?? 4
}

/** 拍号 -> [分子, 分母]，供 Tone.Transport.timeSignature 使用 */
export function timeSignatureParts(ts: TimeSignature): [number, number] {
  const [num, den] = ts.split('/')
  return [Number(num), Number(den)]
}

/** 拍号分母（4 = 四分音符，8 = 八分音符），用于确定节拍器点击单位 */
export function timeSignatureDenominator(ts: TimeSignature): number {
  return Number(ts.split('/')[1]) || 4
}

/** 网格吸附：把数值吸附到最近的网格点 */
export function snapTo(value: number, grid: number): number {
  if (grid <= 0) return value
  return Math.round(value / grid) * grid
}

/**
 * 网格取整（向下）：返回数值所在「格子」的起点。
 * 与 snapTo（吸附到最近网格线）不同，这里以点击位置所在的整格为准，
 * 避免点在格子右半部分时被吸附到右边那条线，造成「判定偏右」的错觉。
 */
export function floorToGrid(value: number, grid: number): number {
  if (grid <= 0) return value
  // 加极小量修正浮点误差（如 0.75 / 0.25 可能算成 2.9999…）
  return Math.floor(value / grid + 1e-9) * grid
}

/** 修正浮点误差，避免出现 0.30000000000000004 之类的小数 */
export function roundBeat(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 把「拍」转换为 Tone.Transport 的 tick 表示（如 "384i"）。
 * 使用 tick 这种音乐时间单位，BPM 变化时已排期的音符会自动重新缩放；
 * 相比 "小节:拍:十六分" 的三段式表示，tick 分辨率更高，
 * 可以精确表达三十二分音符等更细的网格。
 */
export function beatsToTicks(beats: number, ppq: number): string {
  return `${Math.round(Math.max(0, beats) * ppq)}i`
}

/** 拍 -> 秒 */
export function beatsToSeconds(beats: number, bpm: number): number {
  return beats * (60 / bpm)
}

/** 秒 -> 拍 */
export function secondsToBeats(seconds: number, bpm: number): number {
  return seconds / (60 / bpm)
}

/** 位置显示：第几小节.第几拍.第几个十六分（1 起始，符合音乐习惯） */
export function formatPosition(beats: number, beatsPerBar: number): string {
  const safe = Math.max(0, beats)
  const bar = Math.floor(safe / beatsPerBar) + 1
  const rest = safe - (bar - 1) * beatsPerBar
  const beat = Math.floor(rest) + 1
  const sixteenth = Math.floor((rest - Math.floor(rest)) * 4) + 1
  return `${bar}.${beat}.${sixteenth}`
}

/** 网格精度对应的显示名 */
export function gridLabel(grid: GridDivision): string {
  switch (grid) {
    case 1:
      return '四分音符'
    case 0.5:
      return '八分音符'
    case 0.125:
      return '三十二分音符'
    default:
      return '十六分音符'
  }
}
