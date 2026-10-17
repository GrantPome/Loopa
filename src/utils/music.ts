import type { GridDivision, TempoPoint, TimeSignature } from '@/types'

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

// ---------------------------------------------------------------- 速度自动化（tempo map）

/** 速度断点：位置（拍）+ 该拍的目标速度 */
export interface TempoBreakpoint {
  beat: number
  bpm: number
}

/**
 * 断点表：以 [0, baseBpm] 为锚点，追加速度点（按拍排序、同拍去重、越界收敛）。
 * 引擎的实时排期与离线渲染都以这张表为准，保证听感一致。
 */
export function tempoBreakpoints(points: TempoPoint[] | undefined, baseBpm: number): TempoBreakpoint[] {
  const anchor: TempoBreakpoint = { beat: 0, bpm: clamp(Math.round(baseBpm) || 120, 40, 200) }
  const list: TempoBreakpoint[] = [anchor]
  const sorted = [...(points ?? [])].sort((a, b) => a.beat - b.beat)
  for (const p of sorted) {
    const beat = Number(p.beat)
    const bpm = clamp(Math.round(Number(p.bpm) || anchor.bpm), 40, 200)
    if (!Number.isFinite(beat) || beat <= 0) continue // 第 0 拍的速度由 baseBpm 决定
    const last = list[list.length - 1]
    if (Math.abs(last.beat - beat) < 1e-6) last.bpm = bpm
    else list.push({ beat: roundBeat(beat), bpm })
  }
  return list
}

/**
 * 一个速度段（从 v0 线性过渡到 v1）跨越 deltaBeats 拍所需的秒数。
 * 采用梯形模型：段内平均速度取 (v0+v1)/2，即 T = Δ拍 × 120 / (v0+v1)。
 * 该模型与 Tone.Transport 对 bpm 参数做 linearRamp（随时间线性）的积分结果完全一致，
 * 因此按这个时长排期斜坡后，Transport 到达下一断点时的拍位恰好对齐。
 */
function tempoSegmentSeconds(deltaBeats: number, v0: number, v1: number): number {
  if (deltaBeats <= 0) return 0
  if (v0 === v1) return deltaBeats * 60 / v0
  return deltaBeats * 120 / (v0 + v1)
}

/**
 * 段内速度线性变化时，走完 targetBeats 拍需要的秒数（解二次方程，段内精确解）。
 * v(x) = v0 + (v1-v0)·x/T，已走拍数 = ∫v dx = v0·x + (v1-v0)·x²/(2T)。
 */
function tempoPartialSeconds(targetBeats: number, v0: number, v1: number, segSeconds: number): number {
  if (targetBeats <= 0) return 0
  if (v0 === v1 || segSeconds <= 0) return targetBeats * 60 / v0
  const k = (v1 - v0) / segSeconds // bpm 每秒变化率
  const disc = Math.max(0, v0 * v0 + 2 * k * targetBeats)
  const x = (-v0 + Math.sqrt(disc)) / k
  return clamp(x, 0, segSeconds)
}

/** 第 0 拍到 beat 拍的真实时长（秒，考虑速度曲线）；beat 超出最后断点时按末速度匀速 */
export function beatsToSecondsAt(beat: number, points: TempoPoint[] | undefined, baseBpm: number): number {
  const bps = tempoBreakpoints(points, baseBpm)
  if (beat <= 0) return 0
  let seconds = 0
  let prevBeat = 0
  let v0 = bps[0].bpm
  for (let i = 1; i < bps.length && bps[i].beat <= beat; i += 1) {
    seconds += tempoSegmentSeconds(bps[i].beat - prevBeat, v0, bps[i].bpm)
    prevBeat = bps[i].beat
    v0 = bps[i].bpm
  }
  // 尾段：从最后一个已覆盖断点匀速 / 变速走到目标拍
  const next = bps.find((bp) => bp.beat > beat)
  if (next) {
    const seg = tempoSegmentSeconds(next.beat - prevBeat, v0, next.bpm)
    seconds += tempoPartialSeconds(beat - prevBeat, v0, next.bpm, seg)
  } else {
    seconds += (beat - prevBeat) * 60 / v0
  }
  return seconds
}

/** 从 fromBeat 到 toBeat 经历的真实时长（秒，考虑速度曲线） */
export function secondsBetweenBeats(
  fromBeat: number,
  toBeat: number,
  points: TempoPoint[] | undefined,
  baseBpm: number
): number {
  if (toBeat <= fromBeat) return 0
  return beatsToSecondsAt(toBeat, points, baseBpm) - beatsToSecondsAt(fromBeat, points, baseBpm)
}

/** 某一拍上的瞬时速度（BPM）：段内按模型插值，仅用于显示与音符时长估算 */
export function bpmAtBeat(beat: number, points: TempoPoint[] | undefined, baseBpm: number): number {
  const bps = tempoBreakpoints(points, baseBpm)
  if (beat <= 0 || bps.length === 1) return bps[0].bpm
  let prevBeat = 0
  let v0 = bps[0].bpm
  for (let i = 1; i < bps.length; i += 1) {
    const bp = bps[i]
    if (bp.beat <= beat) {
      prevBeat = bp.beat
      v0 = bp.bpm
      continue
    }
    // beat 落在 prevBeat 与 bp.beat 之间：求段内瞬时速度
    const seg = tempoSegmentSeconds(bp.beat - prevBeat, v0, bp.bpm)
    const x = tempoPartialSeconds(beat - prevBeat, v0, bp.bpm, seg)
    if (seg <= 0 || v0 === bp.bpm) return v0
    const k = (bp.bpm - v0) / seg
    return clamp(v0 + k * x, 40, 200)
  }
  return v0
}
