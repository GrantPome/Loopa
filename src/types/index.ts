/**
 * 全局数据类型定义
 * 所有时间单位统一使用「拍（beat）」，与 BPM 解耦，
 * 播放时再交给 Tone.Transport 换算成实际秒数。
 */

/** 拍号：MVP 只支持 4/4 与 3/4 */
export type TimeSignature = '4/4' | '3/4'

/** 旋律类音色（统一用 PolySynth 包装，可弹和弦） */
export type MelodicInstrumentType =
  | 'piano'
  | 'electricPiano'
  | 'organ'
  | 'guitar'
  | 'bass'
  | 'strings'
  | 'brass'
  | 'flute'
  | 'bell'
  | 'pad'
  | 'synthLead'

/** 鼓组音色（按 GM MIDI 音号映射到不同鼓件） */
export type DrumInstrumentType = 'drums' | 'electroDrums'

/** 全部内置音色 */
export type InstrumentType = MelodicInstrumentType | DrumInstrumentType

/**
 * 网格精度（单位：拍）
 * 1 = 四分音符，0.5 = 八分音符，0.25 = 十六分音符，0.125 = 三十二分音符
 */
export type GridDivision = 1 | 0.5 | 0.25 | 0.125

/** 力度范围（0~1 线性） */
export const VELOCITY_MIN = 0
export const VELOCITY_MAX = 1

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

/** 均衡器频段标识（与 Track 上的字段名一一对应） */
export type EqBand = 'eqLow' | 'eqMid' | 'eqHigh'

/** 一条乐器轨道 */
export interface Track {
  id: string
  name: string
  instrument: InstrumentType
  /** 音量推子 0~1 */
  volume: number
  /** 声像 -1（左）~ 1（右） */
  pan: number
  /** 三段均衡：低频增益（dB），范围 EQ_MIN ~ EQ_MAX */
  eqLow: number
  /** 三段均衡：中频增益（dB） */
  eqMid: number
  /** 三段均衡：高频增益（dB） */
  eqHigh: number
  /** 混响发送量 0~1：本轨送入共享混响总线的比例 */
  reverbSend: number
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
  /** 主混响返回量 0~1（共享混响总线送回主输出的电平） */
  reverbWet: number
  /** 总线限幅阈值（dB），范围 LIMITER_MIN ~ 0，用于防止削波 */
  masterLimiter: number
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

/** 混音视图里的编辑视图模式 */
export type ViewMode = 'piano' | 'mixer'

/** 均衡器增益范围（dB） */
export const EQ_MIN = -18
export const EQ_MAX = 18

/** 总线限幅阈值范围（dB） */
export const LIMITER_MIN = -24
export const LIMITER_MAX = 0

/** 均衡器三个频段的展示信息 */
export const EQ_BANDS: { key: EqBand; label: string }[] = [
  { key: 'eqLow', label: '低' },
  { key: 'eqMid', label: '中' },
  { key: 'eqHigh', label: '高' }
]

/** 音色下拉框选项 */
export const INSTRUMENT_OPTIONS: { value: InstrumentType; label: string }[] = [
  { value: 'piano', label: '钢琴' },
  { value: 'electricPiano', label: '电钢琴' },
  { value: 'organ', label: '风琴' },
  { value: 'guitar', label: '吉他' },
  { value: 'bass', label: '贝斯' },
  { value: 'strings', label: '弦乐' },
  { value: 'brass', label: '铜管' },
  { value: 'flute', label: '长笛' },
  { value: 'bell', label: '铃铛' },
  { value: 'pad', label: '氛围铺底' },
  { value: 'synthLead', label: '合成主音' },
  { value: 'drums', label: '鼓组' },
  { value: 'electroDrums', label: '电子鼓组' }
]

export const INSTRUMENT_LABELS: Record<InstrumentType, string> = {
  piano: '钢琴',
  electricPiano: '电钢琴',
  organ: '风琴',
  guitar: '吉他',
  bass: '贝斯',
  strings: '弦乐',
  brass: '铜管',
  flute: '长笛',
  bell: '铃铛',
  pad: '氛围铺底',
  synthLead: '合成主音',
  drums: '鼓组',
  electroDrums: '电子鼓组'
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
  '#8fa8ff',
  '#9be36b',
  '#ff9f7a'
]
