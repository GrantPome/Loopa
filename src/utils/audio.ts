/**
 * 音频数值换算工具
 * 专业 DAW 习惯用 dB 描述音量、用 0~127 描述力度，
 * 这里集中提供线性增益、dB、力度之间的换算，避免各组件各写一份。
 */
import { clamp } from './music'

/** 线性增益 → dB 文本；0（或极小值）显示为 -∞ */
export function gainToDbText(gain: number, digits = 1): string {
  if (gain <= 0.0001) return '-∞'
  return (20 * Math.log10(gain)).toFixed(digits)
}

/** dB → 线性增益 */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** 线性增益 → dB 数值（不做文本格式化） */
export function gainToDb(gain: number): number {
  if (gain <= 0.0001) return -Infinity
  return 20 * Math.log10(gain)
}

/** 力度 0~1 → MIDI 力度 0~127 */
export function velocityToMidi(velocity: number): number {
  return clamp(Math.round(velocity * 127), 0, 127)
}

/** MIDI 力度 0~127 → 0~1 */
export function midiToVelocity(midi: number): number {
  return clamp(midi / 127, 0, 1)
}
