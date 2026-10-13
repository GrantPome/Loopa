/**
 * 全局数据类型定义
 * 所有时间单位统一使用「拍（beat）」，与 BPM 解耦，
 * 播放时再交给 Tone.Transport 换算成实际秒数。
 */

/** 拍号：MVP 只支持 4/4 与 3/4 */
export type TimeSignature = '4/4' | '3/4'

/** 内置音色 */
export type InstrumentType = 'piano' | 'electricPiano' | 'bass' | 'strings' | 'drums'

/** 网格精度：0.25 = 16 分音符，0.5 = 8 分音符（单位：拍） */
export type GridDivision = 0.25 | 0.5

/** 单个音符 */
export interface Note {
  id: string
  /** MIDI 音号 0~127（C4 = 60） */
  midi: number
  /** 相对片段起点的起始位置（拍） */
  start: number
  /** 时长（拍） */
  duration: number
  /** 力度 0~1 */
  velocity: number
}

/** 片段 Region：一段连续的时间区间，内部存放音符 */
export interface Region {
  id: string
  name: string
  /** 相对工程起点的起始位置（拍） */
  start: number
  /** 长度（拍） */
  length: number
  notes: Note[]
}

/** 一条乐器轨道 */
export interface Track {
  id: string
  name: string
  instrument: InstrumentType
  /** 音量推子 0~1 */
  volume: number
  /** 声像 -1（左）~ 1（右） */
  pan: number
  mute: boolean
  solo: boolean
  /** UI 上的轨道颜色标识 */
  color: string
  regions: Region[]
}

/** 工程（可序列化为 JSON 存 localStorage / 导出文件） */
export interface Project {
  id: string
  name: string
  /** 速度 40~200 */
  bpm: number
  timeSignature: TimeSignature
  /** 总输出音量 0~1 */
  masterVolume: number
  /** 主输出混响湿度 0~1 */
  reverbWet: number
  /** 工程小节数（决定时间轴长度） */
  bars: number
  tracks: Track[]
  createdAt: number
  updatedAt: number
}

/** 历史工程列表项（只存元信息，避免列表页加载全部音符） */
export interface ProjectMeta {
  id: string
  name: string
  bpm: number
  timeSignature: TimeSignature
  trackCount: number
  noteCount: number
  updatedAt: number
}

/** 音色下拉框选项 */
export const INSTRUMENT_OPTIONS: { value: InstrumentType; label: string }[] = [
  { value: 'piano', label: '钢琴' },
  { value: 'electricPiano', label: '电钢琴' },
  { value: 'bass', label: '贝斯' },
  { value: 'strings', label: '弦乐' },
  { value: 'drums', label: '鼓组' }
]

export const INSTRUMENT_LABELS: Record<InstrumentType, string> = {
  piano: '钢琴',
  electricPiano: '电钢琴',
  bass: '贝斯',
  strings: '弦乐',
  drums: '鼓组'
}

/** 轨道配色（参考库乐队，简约低饱和） */
export const TRACK_COLORS = [
  '#4f9df7',
  '#f7a24f',
  '#63c78d',
  '#c47ef0',
  '#f06a8a',
  '#4fd0d0',
  '#e8c34f',
  '#8fa8ff'
]
