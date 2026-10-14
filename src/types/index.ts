/**
 * 全局数据类型定义
 * 所有时间单位统一使用「拍（beat）」，与 BPM 解耦，
 * 播放时再交给 Tone.Transport 换算成实际秒数。
 */

/**
 * 拍号：覆盖常用单拍子与复拍子。
 * 注意：内部「拍（beat）」始终以四分音符为单位，
 * 因此 6/8 = 3 拍、7/8 = 3.5 拍、12/8 = 6 拍（详见 beatsPerBarOf）。
 */
export type TimeSignature = '2/4' | '3/4' | '4/4' | '5/4' | '6/8' | '7/8' | '9/8' | '12/8'

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

/**
 * 轨道类型：
 * - midi：由内置合成器演奏，编辑对象是音符（钢琴卷帘）
 * - audio：由录音 / 导入的波形构成，编辑对象是音频片段（波形编辑器）
 */
export type TrackKind = 'midi' | 'audio'

/**
 * 音频片段（波形）。
 * PCM 采样数据体积大，存放于 IndexedDB（key 为索引键）；
 * 工程 JSON 只保存可序列化的元信息与降采样后的波形峰值。
 */
export interface AudioClip {
  id: string
  name: string
  /** 相对工程起点的起始位置（拍） */
  start: number
  /** 片段在时间轴上的时长（拍） */
  duration: number
  /** 相对源音频起点的偏移（秒），用于左边缘修剪 */
  offset: number
  /** 源音频总时长（秒），用于限制修剪范围 */
  sourceDuration: number
  /** 源采样率 */
  sampleRate: number
  /** IndexedDB 中的索引键 */
  key: string
  /** 片段增益 0~2（1 为原始音量） */
  gain: number
  /** 淡入时长（拍） */
  fadeIn: number
  /** 淡出时长（拍） */
  fadeOut: number
  /** 波形峰值缓存：按时间均匀采样，元素为归一化的 [min,max] 交替值（-1~1） */
  peaks: number[]
}

// ---------------------------------------------------------------- 效果器

/** 内置效果器类型 */
export type EffectType = 'compressor' | 'delay' | 'chorus' | 'distortion' | 'filter' | 'phaser'

/** 一个挂在轨道上的效果器实例 */
export interface TrackEffect {
  id: string
  type: EffectType
  enabled: boolean
  /** 参数键 → 数值（键名与 EffectDef.params 对应） */
  params: Record<string, number>
}

/** 单个可调参数的描述（供 UI 自动生成滑块） */
export interface EffectParamDef {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
  /** 数值单位（用于显示，如 dB / ms / Hz） */
  unit?: string
}

/** 效果器定义：名称、说明与全部参数 */
export interface EffectDef {
  type: EffectType
  label: string
  desc: string
  params: EffectParamDef[]
}

/** 内置效果器清单（顺序即 UI 下拉框顺序） */
export const EFFECT_DEFS: EffectDef[] = [
  {
    type: 'compressor',
    label: '压缩器',
    desc: '压制动态范围，让音量更稳定、更有冲击力',
    params: [
      { key: 'threshold', label: '阈值', min: -60, max: 0, step: 1, default: -24, unit: 'dB' },
      { key: 'ratio', label: '压缩比', min: 1, max: 20, step: 0.5, default: 4, unit: ':1' },
      { key: 'attack', label: '启动', min: 0.001, max: 0.5, step: 0.001, default: 0.01, unit: 's' },
      { key: 'release', label: '释放', min: 0.01, max: 1, step: 0.01, default: 0.25, unit: 's' },
      { key: 'makeup', label: '补偿增益', min: 0, max: 12, step: 0.5, default: 0, unit: 'dB' }
    ]
  },
  {
    type: 'delay',
    label: '延迟',
    desc: '回声效果，可制造空间感与节奏型重复',
    params: [
      { key: 'delayTime', label: '延迟时间', min: 0.01, max: 1, step: 0.01, default: 0.25, unit: 's' },
      { key: 'feedback', label: '反馈', min: 0, max: 0.95, step: 0.01, default: 0.35 },
      { key: 'wet', label: '湿度', min: 0, max: 1, step: 0.01, default: 0.3 }
    ]
  },
  {
    type: 'chorus',
    label: '合唱',
    desc: '轻微音高抖动，让声音更宽、更厚',
    params: [
      { key: 'frequency', label: '频率', min: 0.1, max: 8, step: 0.1, default: 1.5, unit: 'Hz' },
      { key: 'depth', label: '深度', min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: 'delayTime', label: '延迟', min: 1, max: 20, step: 0.5, default: 3.5, unit: 'ms' },
      { key: 'wet', label: '湿度', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  },
  {
    type: 'distortion',
    label: '失真',
    desc: '削波过载，用于增加谐波与攻击性',
    params: [
      { key: 'distortion', label: '失真量', min: 0, max: 1, step: 0.01, default: 0.3 },
      { key: 'wet', label: '湿度', min: 0, max: 1, step: 0.01, default: 1 }
    ]
  },
  {
    type: 'filter',
    label: '滤波',
    desc: '低通 / 高通滤波，塑造音色明暗',
    params: [
      { key: 'frequency', label: '截止频率', min: 40, max: 18000, step: 10, default: 1200, unit: 'Hz' },
      { key: 'Q', label: '共振', min: 0.1, max: 20, step: 0.1, default: 1 },
      { key: 'mode', label: '类型', min: 0, max: 1, step: 1, default: 0 }
    ]
  },
  {
    type: 'phaser',
    label: '移相',
    desc: '相位扫频，制造流动的金属感',
    params: [
      { key: 'frequency', label: '频率', min: 0.1, max: 8, step: 0.1, default: 0.5, unit: 'Hz' },
      { key: 'octaves', label: '范围', min: 1, max: 6, step: 0.5, default: 3, unit: 'oct' },
      { key: 'baseFrequency', label: '基频', min: 50, max: 2000, step: 10, default: 350, unit: 'Hz' },
      { key: 'wet', label: '湿度', min: 0, max: 1, step: 0.01, default: 0.5 }
    ]
  }
]

/** 效果器类型 → 定义（快速查找） */
export const EFFECT_DEF_MAP: Record<EffectType, EffectDef> = EFFECT_DEFS.reduce(
  (map, def) => {
    map[def.type] = def
    return map
  },
  {} as Record<EffectType, EffectDef>
)

/** 按定义生成一组默认参数 */
export function defaultEffectParams(type: EffectType): Record<string, number> {
  const def = EFFECT_DEF_MAP[type]
  const params: Record<string, number> = {}
  def.params.forEach((p) => {
    params[p.key] = p.default
  })
  return params
}

/** 均衡器频段标识（与 Track 上的字段名一一对应） */
export type EqBand = 'eqLow' | 'eqMid' | 'eqHigh'

/**
 * 音量读数的显示单位：
 * - db：对数刻度（专业 DAW 常见，如 -1.9）
 * - linear：线性刻度（0~100%），直观反映增益比例
 * 底层存储始终是线性增益，这里只影响界面如何呈现。
 */
export type VolumeDisplay = 'db' | 'linear'

/**
 * UI 适配的设备模式：
 * - pc：桌面端，鼠标 + 键盘，交互精确，信息密度高
 * - pad：平板端，触控优先，控件放大，虚拟键盘常驻，用长按替代右键
 * 用户可手动切换，方便在触屏 PC 或带键盘的平板上自由选择。
 */
export type DeviceMode = 'pc' | 'pad'

/**
 * 布局区域：左侧栏 / 中央主区 / 底部栏
 * 每个区域是一个弹性容器，内部按顺序排列若干功能板块。
 */
export type RegionId = 'left' | 'center' | 'bottom'

/** 可自由编排位置的功能板块 */
export type PanelId = 'tracks' | 'fx' | 'editor' | 'keyboard' | 'master'

/**
 * 可持久化的布局配置：
 * - left/center/bottom：各区域内的板块顺序
 * - leftWidth/bottomHeight：区域尺寸（拖拽区域分隔条调整）
 * - panelWeight：板块在所属区域主轴上的尺寸权重（拖拽板块间分隔条调整）
 */
export interface LayoutConfig {
  left: PanelId[]
  center: PanelId[]
  bottom: PanelId[]
  leftWidth: number
  bottomHeight: number
  panelWeight: Record<PanelId, number>
}

/** 一条轨道（MIDI 乐器轨或音频轨） */
export interface Track {
  id: string
  name: string
  /** 轨道类型：midi（音符）/ audio（波形）。旧数据缺省视为 midi */
  kind: TrackKind
  /** 音色：仅 midi 轨使用；audio 轨保留该字段以兼容统一结构 */
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
  /** 插入式效果器链（按顺序串联在乐器/音频源之后、均衡之前） */
  effects: TrackEffect[]
  mute: boolean
  solo: boolean
  /** UI 上的轨道颜色标识 */
  color: string
  /** MIDI 轨的片段（含音符） */
  regions: Region[]
  /** 音频轨的波形片段 */
  clips: AudioClip[]
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

/**
 * 中央编辑区的视图模式：
 * - piano：钢琴卷帘（MIDI 轨音符编辑）
 * - audio：波形编辑器（音频轨片段修剪）
 * - mixer：混音台
 */
export type ViewMode = 'piano' | 'audio' | 'mixer'

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

/** 拍号下拉框选项（含复合拍子） */
export const TIME_SIGNATURE_OPTIONS: { value: TimeSignature; label: string }[] = [
  { value: '2/4', label: '2/4' },
  { value: '3/4', label: '3/4' },
  { value: '4/4', label: '4/4' },
  { value: '5/4', label: '5/4' },
  { value: '6/8', label: '6/8' },
  { value: '7/8', label: '7/8' },
  { value: '9/8', label: '9/8' },
  { value: '12/8', label: '12/8' }
]
