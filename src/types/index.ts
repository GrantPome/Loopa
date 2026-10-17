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

/**
 * 全部音色类型。
 * 'custom' 表示用户导入采样组成的自定义音源，
 * 具体指向哪一套音源由 Track.customInstrumentId 决定。
 */
export type InstrumentType = MelodicInstrumentType | DrumInstrumentType | 'custom'

// ---------------------------------------------------------------- 自定义音源

/**
 * 自定义音源类型：
 * - melodic：旋律采样器，按采样原始音高做就近匹配 + 移调，可弹任意音高
 * - drum：鼓组采样，每个采样绑定一个 MIDI 音号，命中即原速播放（不移调）
 */
export type CustomInstrumentKind = 'melodic' | 'drum'

/** 一个采样：PCM 数据存放在 IndexedDB（key），工程 JSON 只留元信息 */
export interface CustomSample {
  id: string
  name: string
  /** IndexedDB 中的采样键 */
  key: string
  /** 采样原始音高（MIDI 音号），旋律音源据此计算移调量 */
  rootMidi: number
  /** 采样绑定的目标 MIDI 音号：鼓组音源据此决定命中哪个鼓件 */
  midi: number
  /** 采样增益 0~2（1 为原始音量） */
  gain: number
  /** 源音频时长（秒），用于界面显示 */
  duration: number
}

/** 一套自定义音源：由若干采样组成，作为独立音色供轨道使用 */
export interface CustomInstrument {
  id: string
  name: string
  kind: CustomInstrumentKind
  /** 整体增益 0~2 */
  gain: number
  samples: CustomSample[]
  createdAt: number
  updatedAt: number
}

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
 * - group：编组 / 总线轨，自身不发声，仅把子轨信号汇总后统一处理（效果链、均衡、推子）
 */
export type TrackKind = 'midi' | 'audio' | 'group'

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
  /**
   * 是否按工程速度对齐（warp）：
   * 开启后片段以变速率重采样铺满片段时长，工程改速度时片段跟随伸缩；
   * 关闭时按原始速度播放（经典「磁带」模式）。
   */
  warp: boolean
  /** 半音移调量 -24~24，0 为原始音高（与 warp 变速率带来的音高变化叠加） */
  pitchShift: number
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
  /**
   * 侧链压缩配置（仅 compressor 使用）：
   * 用 sourceTrackId 这条轨道的电平包络去压低本轨增益，实现「kick 一响，pad 让路」的效果。
   * amount 为最大衰减量（dB），release 为恢复时间（秒）。
   */
  sidechain?: {
    sourceTrackId: string
    amount: number
    release: number
  }
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

/** 可自由编排位置的功能板块 */
export type PanelId = 'tracks' | 'fx' | 'editor' | 'inspector' | 'keyboard' | 'master'

/** 拖放方位：把板块插入到目标板块的上 / 下 / 左 / 右 */
export type DropZone = 'top' | 'bottom' | 'left' | 'right'

/** 布局树叶子节点：一个功能板块 */
export interface PanelNode {
  type: 'panel'
  id: PanelId
}

/**
 * 布局树分支节点：沿 dir 方向排列若干子节点
 * - dir：'row' 横向并排 / 'column' 纵向堆叠
 * - sizes：各子节点占主轴的比例（与 children 等长，总和为 1）
 * - key：稳定标识，供列表渲染复用组件实例（重排后画布等内部状态不丢失）
 */
export interface SplitNode {
  type: 'split'
  key: string
  dir: 'row' | 'column'
  children: LayoutNode[]
  sizes: number[]
}

/** 布局树节点 */
export type LayoutNode = PanelNode | SplitNode

/** 可持久化的布局配置：一棵可任意嵌套的布局树 */
export interface LayoutConfig {
  root: LayoutNode
}

// ---------------------------------------------------------------- 自动化包络

/** 均衡器增益范围（dB）；放在此处是因为自动化参数表在模块初始化时就会读它 */
export const EQ_MIN = -18
export const EQ_MAX = 18

/** 总线限幅阈值范围（dB） */
export const LIMITER_MIN = -24
export const LIMITER_MAX = 0

/**
 * 可被自动化控制的轨道参数。
 * 值域与 Track 上的同名字段一致（音量 0~1、声像 -1~1、发送 0~1、均衡 dB）。
 */
export type AutomationParam = 'volume' | 'pan' | 'reverbSend' | 'eqLow' | 'eqMid' | 'eqHigh'

/** 自动化参数的可选清单（顺序即 UI 下拉框顺序） */
export const AUTOMATION_PARAMS: {
  key: AutomationParam
  label: string
  min: number
  max: number
  /** 默认值（该参数无自动化点时的静态值取 Track 字段） */
  def: number
}[] = [
  { key: 'volume', label: '音量', min: 0, max: 1, def: 0.8 },
  { key: 'pan', label: '声像', min: -1, max: 1, def: 0 },
  { key: 'reverbSend', label: '混响发送', min: 0, max: 1, def: 0.2 },
  { key: 'eqLow', label: '均衡·低', min: EQ_MIN, max: EQ_MAX, def: 0 },
  { key: 'eqMid', label: '均衡·中', min: EQ_MIN, max: EQ_MAX, def: 0 },
  { key: 'eqHigh', label: '均衡·高', min: EQ_MIN, max: EQ_MAX, def: 0 }
]

/** 自动化参数定义快速查找 */
export const AUTOMATION_PARAM_MAP: Record<AutomationParam, (typeof AUTOMATION_PARAMS)[number]> =
  AUTOMATION_PARAMS.reduce(
    (map, item) => {
      map[item.key] = item
      return map
    },
    {} as Record<AutomationParam, (typeof AUTOMATION_PARAMS)[number]>
  )

/** 一个自动化关键点：位置（拍）+ 目标值 */
export interface AutomationPoint {
  id: string
  /** 相对工程起点的位置（拍） */
  beat: number
  /** 目标值（按参数各自值域） */
  value: number
}

/** 一条自动化曲线：一个参数对应一条，点之间用线性斜坡连接 */
export interface AutomationLane {
  param: AutomationParam
  points: AutomationPoint[]
}

/**
 * 自动化写入模式（播放时拖推子/旋钮录制参数变化）：
 * - off：不写入
 * - touch：只写入已有曲线的参数
 * - latch：写入且参数还没有曲线时自动新建一条
 */
export type AutomationWriteMode = 'off' | 'touch' | 'latch'

// ---------------------------------------------------------------- 音阶锁定

/** 音阶类型（根音之外的音程结构，单位：半音） */
export type ScaleType =
  | 'chromatic'
  | 'major'
  | 'minor'
  | 'harmonicMinor'
  | 'dorian'
  | 'mixolydian'
  | 'pentatonicMajor'
  | 'pentatonicMinor'
  | 'blues'

/** 音阶定义：名称 + 相对于根音的半音偏移（必须包含 0） */
export interface ScaleDef {
  type: ScaleType
  label: string
  intervals: number[]
}

export const SCALE_DEFS: ScaleDef[] = [
  { type: 'chromatic', label: '十二平均律（不锁定）', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { type: 'major', label: '大调', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { type: 'minor', label: '自然小调', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { type: 'harmonicMinor', label: '和声小调', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { type: 'dorian', label: '多利亚', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { type: 'mixolydian', label: '混合利底亚', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { type: 'pentatonicMajor', label: '大调五声', intervals: [0, 2, 4, 7, 9] },
  { type: 'pentatonicMinor', label: '小调五声', intervals: [0, 3, 5, 7, 10] },
  { type: 'blues', label: '布鲁斯', intervals: [0, 3, 5, 6, 7, 10] }
]

export const SCALE_DEF_MAP: Record<ScaleType, ScaleDef> = SCALE_DEFS.reduce(
  (map, def) => {
    map[def.type] = def
    return map
  },
  {} as Record<ScaleType, ScaleDef>
)

/** 音阶设置：根音（MIDI 音号，通常取 0~11 + 12 的整八度） + 音阶类型 */
export interface ScaleSetting {
  /** 根音 MIDI 音号（界面限制在 C3~B3，即 48~59，便于统一） */
  root: number
  type: ScaleType
}

/** 音阶根音下拉框可选的十二个音名（对应 MIDI 48~59，即 C3~B3） */
export const SCALE_ROOT_OPTIONS: { value: number; label: string }[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B'
].map((label, index) => ({ value: 48 + index, label }))

/** 判断某个音高是否落在给定音阶内 */
export function isInScale(midi: number, scale: ScaleSetting): boolean {
  const def = SCALE_DEF_MAP[scale.type] ?? SCALE_DEF_MAP.major
  const offset = (((midi - scale.root) % 12) + 12) % 12
  return def.intervals.includes(offset)
}

/**
 * 把音高吸附到音阶内：取最近的合法音高，距离相同时优先向下，
 * 保证拖动音符时手感稳定、不会来回跳。
 */
export function snapMidiToScale(midi: number, scale: ScaleSetting): number {
  const def = SCALE_DEF_MAP[scale.type] ?? SCALE_DEF_MAP.major
  if (def.intervals.length >= 12) return midi
  for (let delta = 0; delta <= 6; delta += 1) {
    if (isInScale(midi - delta, scale)) return midi - delta
    if (isInScale(midi + delta, scale)) return midi + delta
  }
  return midi
}

/** 把一组音高按音阶修正，返回修正后的结果（供「量化到音阶」使用） */
export function quantizeMidiToScale(midi: number, scale: ScaleSetting): number {
  return clampMidi(snapMidiToScale(midi, scale))
}

/**
 * 音高合法性兜底（避免量化后越界）。
 * 这里直接用钢琴卷帘的音高范围常量值（MIN_MIDI=12 / MAX_MIDI=96），
 * 不从 utils/music 引入，避免 types 与 utils 之间形成循环依赖。
 */
function clampMidi(midi: number): number {
  return Math.max(12, Math.min(96, midi))
}

/** 一条轨道（MIDI 乐器轨或音频轨） */
export interface Track {
  id: string
  name: string
  /** 轨道类型：midi（音符）/ audio（波形）。旧数据缺省视为 midi */
  kind: TrackKind
  /** 音色：仅 midi 轨使用；audio 轨保留该字段以兼容统一结构 */
  instrument: InstrumentType
  /** 当 instrument === 'custom' 时，指向 Project.customInstruments 中的音源 id */
  customInstrumentId: string
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
  /**
   * 父编组轨 id：为空表示挂在主干总线上。
   * 仅指向 kind === 'group' 的轨道，信号会先汇入父编组的入口再统一处理。
   */
  parentId: string
  /** 自动化包络：每个可自动化参数最多一条曲线 */
  automation: AutomationLane[]
}

/**
 * 时间轴标记点（标点）：
 * 用户在时间轴上打下的位置锚点，用于快速跳转（上一个 / 下一个），
 * 也可由「自动卡点」从音频波形检测出的重音批量生成。
 */
export interface TimelineMarker {
  id: string
  /** 位置（拍） */
  beat: number
  /** 显示名；自动卡点生成时为「卡点 N」 */
  label: string
}

/**
 * 速度自动化关键点：
 * 相邻两点之间速度按时间线性过渡（梯形模型），
 * 工程起点（第 0 拍）的速度始终取 Project.bpm，因此点的位置必须大于 0。
 */
export interface TempoPoint {
  id: string
  /** 位置（拍），> 0 */
  beat: number
  /** 该拍的目标速度（BPM，40~200） */
  bpm: number
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
  /** 工程内的自定义音源库（采样元信息；PCM 存放于 IndexedDB） */
  customInstruments: CustomInstrument[]
  /** 音阶设置：音阶锁定开启时，写谱与拖动音符都会吸附到该音阶 */
  scale: ScaleSetting
  /** 时间轴标记点（标点 / 卡点），按位置升序存放 */
  markers: TimelineMarker[]
  /** 速度自动化关键点（空数组表示恒定速度），按位置升序存放 */
  tempoPoints: TempoPoint[]
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

/**
 * 「乐器与音源」管理器的页签：
 * - builtin：浏览内置乐器，试听并查看鼓件映射
 * - custom：管理自定义音源（导入采样、分配音号）
 */
export type InstrumentManagerTab = 'builtin' | 'custom'

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
  electroDrums: '电子鼓组',
  custom: '自定义音源'
}

/**
 * 解析轨道音色的显示名：
 * 内置音色直接取标签，自定义音色则取对应音源的名字（找不到时退回「自定义音源」）。
 */
export function resolveInstrumentLabel(
  instrument: InstrumentType,
  customInstruments: CustomInstrument[] | undefined,
  customInstrumentId = ''
): string {
  if (instrument !== 'custom') return INSTRUMENT_LABELS[instrument]
  const found = (customInstruments ?? []).find((c) => c.id === customInstrumentId)
  return found ? found.name : INSTRUMENT_LABELS.custom
}

/**
 * GM 标准鼓件映射（简化版）：供自定义鼓组音源分配音号时选择。
 * 与内置 DrumKit 的映射保持一致，方便用户把采样挂到熟悉的音号上。
 */
export const GM_DRUM_NOTES: { midi: number; label: string }[] = [
  { midi: 35, label: '底鼓 2' },
  { midi: 36, label: '底鼓 1' },
  { midi: 37, label: '边击' },
  { midi: 38, label: '军鼓 1' },
  { midi: 39, label: '拍手' },
  { midi: 40, label: '军鼓 2' },
  { midi: 41, label: '低音通鼓' },
  { midi: 42, label: '闭合踩镲' },
  { midi: 43, label: '高音通鼓' },
  { midi: 44, label: '踏镲' },
  { midi: 45, label: '中低音通鼓' },
  { midi: 46, label: '开镲' },
  { midi: 47, label: '中音通鼓' },
  { midi: 48, label: '中高音通鼓' },
  { midi: 49, label: '吊镲 1（大擦）' },
  { midi: 50, label: '高音通鼓' },
  { midi: 51, label: '叮叮镲 1' },
  { midi: 52, label: '中国镲' },
  { midi: 53, label: '镲铃' },
  { midi: 54, label: '铃鼓' },
  { midi: 55, label: '水镲' },
  { midi: 56, label: '牛铃' },
  { midi: 57, label: '吊镲 2' },
  { midi: 59, label: '叮叮镲 2' }
]

/** 按音号查找 GM 鼓件名称（未收录时退回音号文本） */
export function drumNoteLabel(midi: number): string {
  return GM_DRUM_NOTES.find((n) => n.midi === midi)?.label ?? `音号 ${midi}`
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
