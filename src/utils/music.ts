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

/** 拍号 -> 每小节拍数 */
export function beatsPerBarOf(ts: TimeSignature): number {
  return ts === '3/4' ? 3 : 4
}

/** 网格吸附：把数值吸附到最近的网格点 */
export function snapTo(value: number, grid: number): number {
  if (grid <= 0) return value
  return Math.round(value / grid) * grid
}

/** 修正浮点误差，避免出现 0.30000000000000004 之类的小数 */
export function roundBeat(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 把「拍」转换为 Tone.Transport 的时间表示 "小节:拍:十六分"。
 * 使用这种相对表示法，BPM 变化时已排期的音符会自动重新缩放。
 */
export function beatsToTransportTime(beats: number, beatsPerBar: number): string {
  const safe = Math.max(0, beats)
  let bar = Math.floor(safe / beatsPerBar)
  let rest = safe - bar * beatsPerBar
  let beat = Math.floor(rest)
  let sixteenth = Math.round((rest - beat) * 4)

  // 四舍五入后可能出现 4 个十六分音符，需要进位
  if (sixteenth >= 4) {
    sixteenth = 0
    beat += 1
  }
  if (beat >= beatsPerBar) {
    beat = 0
    bar += 1
  }
  return `${bar}:${beat}:${sixteenth}`
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
  return grid === 0.25 ? '16 分音符' : '8 分音符'
}
