import { reactive } from 'vue'
import type {
  AudioClip,
  AutomationLane,
  AutomationParam,
  AutomationWriteMode,
  CustomInstrument,
  CustomInstrumentKind,
  CustomSample,
  EffectType,
  EqBand,
  FeatureKey,
  GridDivision,
  InstrumentManagerTab,
  InstrumentType,
  Note,
  Project,
  ProjectMeta,
  Region,
  DeviceMode,
  ScaleSetting,
  ScaleType,
  TempoPoint,
  TimeSignature,
  TimelineMarker,
  Track,
  TrackEffect,
  TrackKind,
  ViewMode,
  VolumeDisplay
} from '@/types'
import {
  AUTOMATION_PARAM_MAP,
  EFFECT_DEF_MAP,
  EQ_MAX,
  EQ_MIN,
  INSTRUMENT_LABELS,
  LIMITER_MAX,
  LIMITER_MIN,
  SCALE_DEFS,
  SCALE_DEF_MAP,
  TIME_SIGNATURE_OPTIONS,
  TRACK_COLORS,
  VELOCITY_MAX,
  VELOCITY_MIN,
  defaultEffectParams,
  drumNoteLabel,
  quantizeMidiToScale,
  resolveInstrumentLabel,
  snapMidiToScale
} from '@/types'
import {
  MAX_MIDI,
  MIN_MIDI,
  beatsPerBarOf,
  bpmAtBeat,
  clamp,
  midiToNoteName,
  roundBeat,
  secondsToBeats,
  snapTo,
  uid
} from '@/utils/music'
import { computePeaks } from '@/utils/waveform'
import { audioBufferToWavBlob, downloadBlob } from '@/utils/wav'
import { getAudioEngine } from './audioEngine'
import * as storage from './persistence'
import { historyUi, recordChange, redo as redoSnapshot, resetHistory, undo as undoSnapshot } from './history'
import { parseMidi, projectToMidi } from './midi'
import {
  deletePcm,
  getCachedPcm,
  preloadPcm,
  prunePcm,
  putPcm,
  type PcmData
} from './audioStore'
import { decodeAudioFile, isRecording, recordingSeconds, startRecording, stopRecording } from './recorder'

const engine = getAudioEngine()

export { historyUi }

/** 新轨道的默认混音参数 */
const DEFAULT_MIX = {
  volume: 0.8,
  pan: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  reverbSend: 0.2
}

/** 音频轨默认不送混响：录进来的声音通常希望保持原样 */
const DEFAULT_AUDIO_MIX = { ...DEFAULT_MIX, reverbSend: 0 }

/** 视图状态（钢琴卷帘与时间总轨共享，保证两处刻度对齐） */
export interface ViewState {
  /** 每拍像素宽（缩放） */
  pxPerBeat: number
  /** 横向滚动位置（px） */
  scrollLeft: number
  /** 钢琴卷帘行高 */
  rowHeight: number
}

export interface AppState {
  project: Project
  selectedTrackId: string
  selectedNoteIds: string[]
  /** 当前选中的音频片段 id（波形编辑器使用） */
  selectedClipId: string
  /** 当前选中的标记点 id（时间轴标记使用） */
  selectedMarkerId: string
  isPlaying: boolean
  /** 预备拍进行中 */
  isCountingIn: boolean
  /** 录音进行中 */
  recording: boolean
  /** 本次录音的起始位置（拍） */
  recordingStartBeat: number
  /** 已录制时长（秒），供界面显示 */
  recordingSeconds: number
  playheadBeats: number
  snapDivision: GridDivision
  metronomeOn: boolean
  countInOn: boolean
  loopOn: boolean
  /** 虚拟键盘高亮的音高 */
  activePitches: number[]
  /** 中央编辑区当前展示的视图 */
  viewMode: ViewMode
  /** 钢琴卷帘底部力度编辑条是否展开 */
  velocityLaneOn: boolean
  /** 钢琴卷帘底部自动化包络条是否展开 */
  automationLaneOn: boolean
  /** 当前正在编辑的自动化参数 */
  automationParam: AutomationParam
  /** 自动化写入模式：off 关闭 / touch 仅写已有曲线 / latch 允许新建曲线 */
  automationWriteMode: AutomationWriteMode
  /** MIDI 硬件录制待命（armed）：弹奏硬件键盘即写入当前轨道 */
  midiRecordArmed: boolean
  /** 音阶锁定是否开启（开启后写谱与拖动音符都会吸附到工程音阶） */
  scaleLockOn: boolean
  /** 音符是否按力度着色（低力度冷色、高力度暖色） */
  noteColorByVelocity: boolean
  /** 虚拟键盘 / 试听的力度 0~1 */
  keyboardVelocity: number
  /** 音量读数显示单位：dB 或线性（仅影响界面呈现，不改动底层增益） */
  volumeDisplay: VolumeDisplay
  /** 当前 UI 适配的设备模式（pc / pad），用户可手动切换 */
  deviceMode: DeviceMode
  /** 设置对话框是否打开 */
  settingsOpen: boolean
  /** 「乐器与音源」管理器是否打开 */
  instrumentOpen: boolean
  /** 管理器当前展示的页签 */
  instrumentTab: InstrumentManagerTab
  /** Pad 端长按触发时间（ms）：超过该时长即视为长按，用于启动框选或弹出右键菜单 */
  longPressDuration: number
  /** Pad 端是否在底部常驻显示虚拟键盘（PC 端默认折叠） */
  touchKeyboardAlwaysOn: boolean
  /** 功能开关：用户可勾选启停某些可选功能，默认全开 */
  featureToggles: Record<FeatureKey, boolean>
  /** 各轨道实时电平 0~1（键为轨道 id） */
  levels: Record<string, number>
  /** 总线输出电平 0~1 */
  masterLevel: number
  /** 限幅器是否正在压制信号 */
  limiting: boolean
  view: ViewState
  /** 工程数据版本号：任何改动 +1，用于触发重绘与音频重排 */
  revision: number
  savedProjects: ProjectMeta[]
  statusText: string
  audioReady: boolean
  busy: boolean
}

// ---------------------------------------------------------------- 工厂函数

/** 时间轴标记点上限：过多会拖慢时间轴绘制，同时也是「自动卡点」批量生成的上限 */
export const MAX_MARKERS = 500

export function createEmptyProject(name = '未命名工程'): Project {
  const now = Date.now()
  return {
    id: uid('proj'),
    name,
    bpm: 120,
    timeSignature: '4/4',
    masterVolume: 0.8,
    reverbWet: 0.18,
    masterLimiter: -1,
    bars: 8,
    tracks: [],
    customInstruments: [],
    // 默认不锁定音阶（十二平均律），由用户在钢琴卷帘里显式开启
    scale: { root: 48, type: 'chromatic' },
    markers: [],
    tempoPoints: [],
    createdAt: now,
    updatedAt: now
  }
}

function makeRegion(project: Project): Region {
  return {
    id: uid('rgn'),
    name: '片段 1',
    start: 0,
    length: project.bars * beatsPerBarOf(project.timeSignature),
    notes: []
  }
}

export function createTrack(
  project: Project,
  instrument: InstrumentType,
  index: number,
  kind: TrackKind = 'midi',
  customInstrumentId = ''
): Track {
  const isAudio = kind === 'audio'
  const isGroup = kind === 'group'
  const label = resolveInstrumentLabel(instrument, project.customInstruments, customInstrumentId)
  return {
    id: uid('trk'),
    name: isGroup ? `编组 ${index + 1}` : isAudio ? `音频轨 ${index + 1}` : `${label} ${index + 1}`,
    kind,
    instrument,
    customInstrumentId: instrument === 'custom' ? customInstrumentId : '',
    ...(isAudio ? DEFAULT_AUDIO_MIX : DEFAULT_MIX),
    effects: [],
    mute: false,
    solo: false,
    color: isGroup ? '#f0b46a' : isAudio ? '#8fa8ff' : TRACK_COLORS[index % TRACK_COLORS.length],
    // 音频轨与编组轨都不使用片段模型，音符容器留空
    regions: isAudio || isGroup ? [] : [makeRegion(project)],
    clips: [],
    parentId: '',
    automation: []
  }
}

/** 拍号合法性兜底：非法值统一退回 4/4 */
function safeTimeSignature(value: unknown): TimeSignature {
  const found = TIME_SIGNATURE_OPTIONS.find((o) => o.value === value)
  return found ? found.value : '4/4'
}

/** 效果器参数补齐：旧数据可能缺键，缺失的用默认值填充 */
function normalizeEffects(raw: unknown): TrackEffect[] {
  if (!Array.isArray(raw)) return []
  const out: TrackEffect[] = []
  for (const item of raw as Partial<TrackEffect>[]) {
    const type = item?.type as EffectType | undefined
    if (!type || !EFFECT_DEF_MAP[type]) continue
    const defaults = defaultEffectParams(type)
    const params: Record<string, number> = { ...defaults }
    const incoming = item?.params ?? {}
    for (const def of EFFECT_DEF_MAP[type].params) {
      const value = incoming[def.key]
      if (typeof value === 'number' && Number.isFinite(value)) {
        params[def.key] = clamp(value, def.min, def.max)
      }
    }
    out.push({
      id: item?.id ?? uid('fx'),
      type,
      enabled: item?.enabled !== false,
      params,
      // 侧链配置只在压缩器上有效，且必须指向一条真实存在的轨道（这里先存原始 id，稍后统一校验）
      sidechain: normalizeSidechain(item?.sidechain, type)
    })
  }
  return out
}

/** 侧链配置归一化：非法 / 残缺的配置直接丢弃，避免引擎读到无意义的源 */
function normalizeSidechain(
  raw: unknown,
  type: EffectType
): { sourceTrackId: string; amount: number; release: number } | undefined {
  if (type !== 'compressor') return undefined
  const item = raw as { sourceTrackId?: unknown; amount?: unknown; release?: unknown } | undefined
  if (!item || typeof item.sourceTrackId !== 'string' || !item.sourceTrackId) return undefined
  return {
    sourceTrackId: item.sourceTrackId,
    amount: clamp(Number(item.amount ?? 12) || 0, 0, 48),
    release: clamp(Number(item.release ?? 0.2) || 0, 0.01, 2)
  }
}

/** 自动化包络归一化：过滤非法参数与非法点，并按拍排序 */
function normalizeAutomation(raw: unknown): AutomationLane[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<AutomationParam>()
  const out: AutomationLane[] = []
  for (const item of raw as Partial<AutomationLane>[]) {
    const param = item?.param as AutomationParam | undefined
    if (!param || !AUTOMATION_PARAM_MAP[param] || seen.has(param)) continue
    seen.add(param)
    const def = AUTOMATION_PARAM_MAP[param]
    const points = (Array.isArray(item.points) ? item.points : [])
      .map((p) => ({
        id: p?.id ?? uid('apt'),
        beat: Math.max(0, Number(p?.beat) || 0),
        value: clamp(Number(p?.value) || 0, def.min, def.max)
      }))
      .sort((a, b) => a.beat - b.beat)
    // 一个点无法构成曲线，直接舍弃该条 lane
    if (points.length >= 2) out.push({ param, points })
  }
  return out
}

/** 音频片段归一化：补齐旧数据缺失字段，保证波形编辑器不会读到 undefined */
function normalizeClips(raw: unknown): AudioClip[] {
  if (!Array.isArray(raw)) return []
  const out: AudioClip[] = []
  for (const item of raw as Partial<AudioClip>[]) {
    if (!item?.key) continue
    const sourceDuration = Number(item.sourceDuration) || 0
    const sampleRate = Number(item.sampleRate) || 44100
    out.push({
      id: item.id ?? uid('clip'),
      name: item.name ?? '音频',
      start: Math.max(0, Number(item.start) || 0),
      duration: Math.max(0.0625, Number(item.duration) || 1),
      offset: Math.max(0, Number(item.offset) || 0),
      sourceDuration: sourceDuration > 0 ? sourceDuration : 1,
      sampleRate,
      key: item.key,
      gain: clamp(Number(item.gain ?? 1) || 0, 0, 2),
      fadeIn: Math.max(0, Number(item.fadeIn) || 0),
      fadeOut: Math.max(0, Number(item.fadeOut) || 0),
      // 变速对齐与移调是后来加入的字段：旧数据统一回退「原速原调」
      warp: Boolean(item.warp),
      pitchShift: clamp(Number(item.pitchShift) || 0, -24, 24),
      peaks: Array.isArray(item.peaks) ? (item.peaks as number[]) : []
    })
  }
  return out
}

/**
 * 自定义音源归一化：补齐旧数据缺失字段，保证采样结构完整、音号合法。
 * 旧工程没有 customInstruments 字段时返回空数组。
 */
function normalizeCustomInstruments(raw: unknown): CustomInstrument[] {
  if (!Array.isArray(raw)) return []
  const out: CustomInstrument[] = []
  for (const item of raw as Partial<CustomInstrument>[]) {
    if (!item?.id) continue
    const kind: CustomInstrumentKind = item.kind === 'drum' ? 'drum' : 'melodic'
    const samples: CustomSample[] = []
    for (const s of (item.samples ?? []) as Partial<CustomSample>[]) {
      if (!s?.key) continue
      samples.push({
        id: s.id ?? uid('smp'),
        name: s.name ?? '采样',
        key: s.key,
        rootMidi: clamp(Math.round(Number(s.rootMidi) || 60), MIN_MIDI, MAX_MIDI),
        midi: clamp(Math.round(Number(s.midi) || 36), MIN_MIDI, MAX_MIDI),
        gain: clamp(Number(s.gain ?? 1) || 0, 0, 2),
        duration: Math.max(0, Number(s.duration) || 0)
      })
    }
    out.push({
      id: item.id,
      name: item.name ?? '自定义音源',
      kind,
      gain: clamp(Number(item.gain ?? 1) || 0, 0, 2),
      samples,
      createdAt: Number(item.createdAt) || Date.now(),
      updatedAt: Number(item.updatedAt) || Date.now()
    })
  }
  return out
}

/**
 * 补齐工程里可能缺失的字段（兼容旧版本 localStorage 数据与手工编辑过的 JSON）。
 * 音频引擎与 UI 都假设这些字段一定存在，因此在入口处统一做一次归一化。
 */
function normalizeTrack(raw: Partial<Track>, index: number): Track {
  const kind: TrackKind = raw.kind === 'audio' ? 'audio' : raw.kind === 'group' ? 'group' : 'midi'
  const isAudio = kind === 'audio'
  const isGroup = kind === 'group'
  return {
    id: raw.id ?? uid('trk'),
    name: raw.name ?? `轨道 ${index + 1}`,
    kind,
    instrument: (raw.instrument ?? 'piano') as InstrumentType,
    customInstrumentId: typeof raw.customInstrumentId === 'string' ? raw.customInstrumentId : '',
    volume: clamp(raw.volume ?? DEFAULT_MIX.volume, 0, 1),
    pan: clamp(raw.pan ?? DEFAULT_MIX.pan, -1, 1),
    eqLow: clamp(raw.eqLow ?? DEFAULT_MIX.eqLow, EQ_MIN, EQ_MAX),
    eqMid: clamp(raw.eqMid ?? DEFAULT_MIX.eqMid, EQ_MIN, EQ_MAX),
    eqHigh: clamp(raw.eqHigh ?? DEFAULT_MIX.eqHigh, EQ_MIN, EQ_MAX),
    reverbSend: clamp(raw.reverbSend ?? DEFAULT_MIX.reverbSend, 0, 1),
    effects: normalizeEffects(raw.effects),
    mute: Boolean(raw.mute),
    solo: Boolean(raw.solo),
    color: raw.color ?? TRACK_COLORS[index % TRACK_COLORS.length],
    regions: isAudio
      ? []
      : isGroup
        ? []
        : (raw.regions ?? []).map((r) => ({
            id: r.id ?? uid('rgn'),
            name: r.name ?? '片段',
            start: r.start ?? 0,
            length: r.length ?? 0,
            notes: (r.notes ?? []).map((n) => ({
              id: n.id ?? uid('note'),
              midi: n.midi ?? 60,
              start: n.start ?? 0,
              duration: n.duration ?? 0.25,
              velocity: n.velocity ?? 0.85
            }))
          })),
    clips: isGroup ? [] : normalizeClips(raw.clips),
    parentId: typeof raw.parentId === 'string' ? raw.parentId : '',
    automation: normalizeAutomation(raw.automation)
  }
}

export function normalizeProject(raw: Partial<Project>, fallbackName = '未命名工程'): Project {
  const base = createEmptyProject(raw.name ?? fallbackName)
  const customInstruments = normalizeCustomInstruments(raw.customInstruments)
  const tracks = (raw.tracks ?? []).map((t, i) => normalizeTrack(t, i))
  // 引用了已不存在的自定义音源的轨道，回退到内置钢琴，避免出现静音轨道
  const customIds = new Set(customInstruments.map((c) => c.id))
  for (const track of tracks) {
    if (track.instrument === 'custom' && !customIds.has(track.customInstrumentId)) {
      track.instrument = 'piano'
      track.customInstrumentId = ''
    }
  }
  // 编组关系收敛：只允许挂到真实存在的编组轨上，且不能形成环（父子互为对方父级）
  const byId = new Map(tracks.map((t) => [t.id, t]))
  for (const track of tracks) {
    const parent = track.parentId ? byId.get(track.parentId) : undefined
    if (!parent || parent.kind !== 'group' || parent.id === track.id) {
      track.parentId = ''
      continue
    }
    // 父级也挂在当前轨道上（环）时断开，避免信号链自锁
    if (parent.parentId === track.id) parent.parentId = ''
  }
  // 侧链源校验：源轨道必须存在且不是自己
  for (const track of tracks) {
    for (const effect of track.effects) {
      if (effect.sidechain && (!byId.has(effect.sidechain.sourceTrackId) || effect.sidechain.sourceTrackId === track.id)) {
        effect.sidechain = undefined
      }
    }
  }
  return {
    ...base,
    ...raw,
    bpm: clamp(raw.bpm ?? base.bpm, 40, 200),
    timeSignature: safeTimeSignature(raw.timeSignature ?? base.timeSignature),
    masterVolume: clamp(raw.masterVolume ?? base.masterVolume, 0, 1),
    reverbWet: clamp(raw.reverbWet ?? base.reverbWet, 0, 1),
    masterLimiter: clamp(raw.masterLimiter ?? base.masterLimiter, LIMITER_MIN, LIMITER_MAX),
    bars: raw.bars ?? base.bars,
    tracks,
    customInstruments,
    scale: normalizeScale(raw.scale),
    markers: normalizeMarkers(raw.markers),
    tempoPoints: normalizeTempoPoints(raw.tempoPoints),
    createdAt: raw.createdAt ?? base.createdAt,
    updatedAt: raw.updatedAt ?? base.updatedAt
  }
}

/** 音阶设置归一化：非法类型退回十二平均律，根音收敛到 C3~B3 */
function normalizeScale(raw: unknown): ScaleSetting {
  const item = raw as Partial<ScaleSetting> | undefined
  const type = item?.type && SCALE_DEF_MAP[item.type] ? (item.type as ScaleType) : 'chromatic'
  return { root: clamp(Math.round(Number(item?.root ?? 48) || 48), 48, 59), type }
}

/**
 * 速度点归一化：过滤非法项（拍号 ≤ 0、速度越界）、按拍排序并去掉几乎重合的点。
 * 第 0 拍的速度由 Project.bpm 决定，不存进 tempoPoints。
 */
function normalizeTempoPoints(raw: unknown): TempoPoint[] {
  if (!Array.isArray(raw)) return []
  const out: TempoPoint[] = []
  for (const item of raw as Partial<TempoPoint>[]) {
    const beat = Number(item?.beat)
    if (!Number.isFinite(beat) || beat <= 0.001) continue
    const bpm = clamp(Math.round(Number(item?.bpm) || 0), 40, 200)
    if (out.length > 0 && Math.abs(out[out.length - 1].beat - beat) < 0.001) continue
    out.push({ id: item?.id ?? uid('tmp'), beat, bpm })
  }
  return out.sort((a, b) => a.beat - b.beat)
}

/**
 * 标记点归一化：
 * 旧工程没有 markers 字段，这里统一补空数组；
 * 同时过滤非法项、修正浮点、按位置升序排列并限流。
 */
function normalizeMarkers(raw: unknown): TimelineMarker[] {
  if (!Array.isArray(raw)) return []
  const list: TimelineMarker[] = []
  for (const item of raw) {
    const m = item as Partial<TimelineMarker> | undefined
    const beat = Number(m?.beat)
    if (!Number.isFinite(beat)) continue
    list.push({
      id: typeof m?.id === 'string' && m.id ? m.id : uid('mk'),
      beat: Math.max(0, roundBeat(beat)),
      label: typeof m?.label === 'string' && m.label ? m.label : '标记'
    })
  }
  list.sort((a, b) => a.beat - b.beat)
  return list.slice(0, MAX_MARKERS)
}

// ---------------------------------------------------------------- 界面偏好持久化
// 这些设置与工程数据无关，但用户手动切换后应当跨会话保持，
// 因此单独存一份，避免刷新后被重置回默认值（例如设备模式、音量读数单位）。

const UI_PREFS_KEY = 'muisc-editor:v1:ui'

/** 需要跨会话保持的界面偏好 */
interface UiPrefs {
  deviceMode: DeviceMode
  longPressDuration: number
  touchKeyboardAlwaysOn: boolean
  volumeDisplay: VolumeDisplay
  velocityLaneOn: boolean
  noteColorByVelocity: boolean
  featureToggles: Record<FeatureKey, boolean>
}

/** 默认界面偏好：与 AppState 的初始值保持一致 */
function defaultUiPrefs(): UiPrefs {
  return {
    deviceMode: 'pc',
    longPressDuration: 450,
    touchKeyboardAlwaysOn: true,
    volumeDisplay: 'db',
    velocityLaneOn: true,
    noteColorByVelocity: false,
    featureToggles: { metronome: true, countIn: true, markers: true, midi: true }
  }
}

/** 读取界面偏好：缺字段或数据损坏时逐项回退默认值 */
function readUiPrefs(): UiPrefs {
  const base = defaultUiPrefs()
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      deviceMode: parsed.deviceMode === 'pad' ? 'pad' : 'pc',
      longPressDuration: clamp(Number(parsed.longPressDuration) || base.longPressDuration, 150, 2000),
      touchKeyboardAlwaysOn: parsed.touchKeyboardAlwaysOn !== false,
      volumeDisplay: parsed.volumeDisplay === 'linear' ? 'linear' : 'db',
      velocityLaneOn: parsed.velocityLaneOn !== false,
      noteColorByVelocity: parsed.noteColorByVelocity === true,
      featureToggles: { ...base.featureToggles, ...(parsed.featureToggles ?? {}) }
    }
  } catch {
    return base
  }
}

/** 写入界面偏好（存储异常不影响功能） */
function writeUiPrefs(): void {
  try {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({
        deviceMode: state.deviceMode,
        longPressDuration: state.longPressDuration,
        touchKeyboardAlwaysOn: state.touchKeyboardAlwaysOn,
        volumeDisplay: state.volumeDisplay,
        velocityLaneOn: state.velocityLaneOn,
        noteColorByVelocity: state.noteColorByVelocity,
        featureToggles: state.featureToggles
      } as UiPrefs)
    )
  } catch {
    // 忽略存储配额异常，偏好丢失不影响功能
  }
}

/** 启动时读取到的界面偏好，用于初始化 state */
const initialUiPrefs = readUiPrefs()

// ---------------------------------------------------------------- 全局状态

export const state = reactive<AppState>({
  project: createEmptyProject(),
  selectedTrackId: '',
  selectedNoteIds: [],
  selectedClipId: '',
  selectedMarkerId: '',
  isPlaying: false,
  isCountingIn: false,
  recording: false,
  recordingStartBeat: 0,
  recordingSeconds: 0,
  playheadBeats: 0,
  snapDivision: 0.25,
  metronomeOn: false,
  countInOn: true,
  loopOn: true,
  activePitches: [],
  viewMode: 'piano',
  velocityLaneOn: initialUiPrefs.velocityLaneOn,
  automationLaneOn: false,
  automationParam: 'volume',
  automationWriteMode: 'off',
  midiRecordArmed: false,
  scaleLockOn: false,
  noteColorByVelocity: initialUiPrefs.noteColorByVelocity,
  keyboardVelocity: 0.85,
  volumeDisplay: initialUiPrefs.volumeDisplay,
  deviceMode: initialUiPrefs.deviceMode,
  settingsOpen: false,
  instrumentOpen: false,
  instrumentTab: 'builtin',
  longPressDuration: initialUiPrefs.longPressDuration,
  touchKeyboardAlwaysOn: initialUiPrefs.touchKeyboardAlwaysOn,
  featureToggles: { ...initialUiPrefs.featureToggles },
  levels: {},
  masterLevel: 0,
  limiting: false,
  view: { pxPerBeat: 64, scrollLeft: 0, rowHeight: 16 },
  revision: 0,
  savedProjects: [],
  statusText: '',
  audioReady: false,
  busy: false
})

// ---------------------------------------------------------------- 初始化

let tickStarted = false

export function initStore(): void {
  const lastId = storage.readLastProjectId()
  const loaded = lastId ? storage.loadProject(lastId) : null
  if (loaded) {
    state.project = normalizeProject(loaded)
    projectPersisted = true
  } else {
    state.project = createEmptyProject()
    seedDefaultTracks()
    // 首次打开站点时的空白工程同样不落盘，有改动后再进入历史列表
    projectPersisted = false
  }
  state.selectedTrackId = state.project.tracks[0]?.id ?? ''
  state.savedProjects = storage.readMetas()

  // 设备模式等界面偏好已在 state 初始化时从 localStorage 恢复，
  // 这里补跑一次联动效果（如 Pad 模式的行高放大），保证刷新后观感与切换时一致。
  applyDeviceModeEffects()

  // 播放触发音符时，高亮虚拟键盘上对应的琴键（仅当前选中轨道）
  engine.onNoteOn = (midi, trackId) => {
    if (trackId === state.selectedTrackId) highlightPitch(midi)
  }

  resetHistory(state.project)
  startTickLoop()
  applyProjectToEngine()
  syncNow()
  // 音频采样存在 IndexedDB，异步预热后再重排一次，让波形片段可以播放
  void hydrateAudio()
  void pruneOrphanAudio()
}

/** 把工程级的播放参数同步给音频引擎 */
function applyProjectToEngine(): void {
  engine.setBpm(state.project.bpm)
  engine.setTimeSignature(state.project.timeSignature)
  engine.setMasterVolume(state.project.masterVolume)
  engine.setReverbWet(state.project.reverbWet)
  engine.setLimiterThreshold(state.project.masterLimiter)
  engine.setLoop(state.loopOn)
  engine.setMetronome(state.metronomeOn, state.countInOn)
}

/** 新建工程默认放两条轨道，避免首屏空白 */
function seedDefaultTracks(): void {
  const piano = createTrack(state.project, 'piano', 0)
  const drums = createTrack(state.project, 'drums', 1)
  state.project.tracks.push(piano, drums)
}

/**
 * 收集工程中全部需要持久化的采样键：
 * 音频片段引用的采样 + 自定义音源里的采样。
 * 注意：这里也会对 localStorage 里的「历史工程」原始数据调用，
 * 它们可能是旧结构（缺少 tracks / clips / customInstruments），因此逐层兜底。
 */
function collectPcmKeys(project: Project): string[] {
  const keys = new Set<string>()
  ;(project.tracks ?? []).forEach((t) => (t.clips ?? []).forEach((c) => keys.add(c.key)))
  ;(project.customInstruments ?? []).forEach((ci) =>
    (ci.samples ?? []).forEach((s) => keys.add(s.key))
  )
  return Array.from(keys)
}

/** 把工程里用到的采样读入内存缓存，供音频引擎同步取用 */
async function hydrateAudio(): Promise<void> {
  const keys = collectPcmKeys(state.project)
  if (keys.length === 0) return
  const loaded = await preloadPcm(keys)
  if (loaded.length > 0) commit()
}

/** 清理所有历史工程都不再引用的采样，避免 IndexedDB 无限膨胀 */
async function pruneOrphanAudio(): Promise<void> {
  const keep = new Set<string>()
  storage.readProjects().forEach((p) => collectPcmKeys(p).forEach((k) => keep.add(k)))
  collectPcmKeys(state.project).forEach((k) => keep.add(k))
  await prunePcm(Array.from(keep))
}

/**
 * 统一的心跳循环（requestAnimationFrame）：
 * 1. 同步播放头位置与播放状态
 * 2. 采样各轨道与总线的实时电平
 * 3. 处理节流后的音频重排（拖动音符时避免每帧重排）
 * 4. 清理虚拟键盘高亮
 */
function startTickLoop(): void {
  if (tickStarted) return
  tickStarted = true

  let lastFrameAt = performance.now()

  const tick = () => {
    const now = performance.now()
    // 两帧之间真实流逝的毫秒数：侧链包络的平滑时间常数依赖它
    const deltaMs = Math.min(120, now - lastFrameAt)
    lastFrameAt = now

    state.isPlaying = engine.isPlaying
    state.playheadBeats = engine.getBeats()
    if (state.isCountingIn && engine.getBeats() > 0) state.isCountingIn = false
    if (state.recording) state.recordingSeconds = recordingSeconds()

    // 仅在音频上下文就绪后才采样电平，避免未初始化时读到无意义的 0
    if (state.audioReady) {
      sampleLevels()
      // 侧链闪避需要逐帧跟随源轨道包络，放在电平采样之后（复用同一批数据）
      engine.updateSidechain(deltaMs)
    }

    if (syncRequestedAt && performance.now() - syncRequestedAt >= 120) {
      syncRequestedAt = 0
      syncNow()
    }

    pruneHighlights()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

/** 采样所有轨道与总线的实时电平（每帧一次，供混音台电平表使用） */
function sampleLevels(): void {
  const next: Record<string, number> = {}
  for (const track of state.project.tracks) {
    next[track.id] = engine.getTrackLevel(track.id)
  }
  state.levels = next
  state.masterLevel = engine.getMasterLevel()
  state.limiting = engine.isLimiting()
}

// ------------------------------------------------------------ 音频同步 / 持久化

let syncRequestedAt = 0

/**
 * 当前工程是否已写入本地存储。
 * 新建的工程在没有任何改动前不写入历史列表，避免主页出现一堆空白工程；
 * 一旦发生可撤销的编辑（record）或用户手动保存，即置为 true。
 */
let projectPersisted = true

/** 标记需要同步（实际同步在心跳循环里节流执行，不使用 setTimeout 计时） */
export function commit(): void {
  state.revision += 1
  syncRequestedAt = performance.now()
}

/**
 * 记录一步可撤销的改动。
 * 连续型操作（拖推子、拖力度）传入相同的 coalesceKey，会被合并成一步，
 * 避免一次拖拽产生几十条历史记录。
 */
function record(label: string, coalesceKey = ''): void {
  recordChange(state.project, label, coalesceKey)
  // 首次真实编辑：允许后续同步把工程写入历史列表
  projectPersisted = true
}

/** 立即把当前工程同步到音频引擎并写入 localStorage */
function syncNow(): void {
  engine.syncTracks(state.project)
  engine.scheduleProject(state.project)
  engine.updateAllMix(state.project)
  engine.setLoop(state.loopOn)
  state.project.updatedAt = Date.now()
  // 新建且未改动过的工程不落盘，不进入历史列表
  if (!projectPersisted) return
  storage.saveProject(state.project)
  state.savedProjects = storage.readMetas()
}

/** 仅做持久化（不需要重排音符的改动）；手动保存视为用户明确要保留该工程 */
function persistOnly(): void {
  projectPersisted = true
  state.project.updatedAt = Date.now()
  storage.saveProject(state.project)
  state.savedProjects = storage.readMetas()
}

// ---------------------------------------------------------------- 撤销 / 重做

/** 把快照应用回当前工程（撤销/重做的统一入口，不再产生新的历史记录） */
function applySnapshot(snapshot: Project): void {
  stop()
  const project = normalizeProject(snapshot)
  state.project = project
  if (!project.tracks.some((t) => t.id === state.selectedTrackId)) {
    state.selectedTrackId = project.tracks[0]?.id ?? ''
  }
  state.selectedNoteIds = []
  state.selectedClipId = ''
  applyProjectToEngine()
  commit()
  syncNow()
  void hydrateAudio()
}

export function undo(): void {
  const snapshot = undoSnapshot(state.project)
  if (!snapshot) {
    state.statusText = '没有可撤销的操作'
    return
  }
  applySnapshot(snapshot)
  state.statusText = `已撤销：${historyUi.redoLabel || '编辑'}`
}

export function redo(): void {
  const snapshot = redoSnapshot(state.project)
  if (!snapshot) {
    state.statusText = '没有可重做的操作'
    return
  }
  applySnapshot(snapshot)
  state.statusText = `已重做：${historyUi.undoLabel || '编辑'}`
}

// ---------------------------------------------------------------- 轨道操作

export function activeTrack(): Track | undefined {
  return state.project.tracks.find((t) => t.id === state.selectedTrackId)
}

export function activeRegion(): Region | undefined {
  return activeTrack()?.regions[0]
}

export function selectTrack(id: string): void {
  if (state.selectedTrackId === id) return
  state.selectedTrackId = id
  state.selectedNoteIds = []
  state.selectedClipId = ''
  alignViewModeWithTrack(state.project.tracks.find((t) => t.id === id))
}

/**
 * 让中央编辑区视图与轨道类型保持一致：
 * 选中音频轨时从钢琴卷帘切到波形视图，选中 MIDI 轨时从波形视图切回钢琴卷帘，
 * 选中编组轨时切到混音台。混音台之外不做自动切换。
 */
function alignViewModeWithTrack(track: Track | undefined): void {
  // 编组轨自身没有音符 / 波形，切到混音台便于统一处理它的效果链与推子
  if (track?.kind === 'group') {
    if (state.viewMode !== 'mixer') state.viewMode = 'mixer'
    return
  }
  if (track?.kind === 'audio' && state.viewMode === 'piano') state.viewMode = 'audio'
  else if (track?.kind === 'midi' && state.viewMode === 'audio') state.viewMode = 'piano'
}

export function addTrack(instrument: InstrumentType = 'piano', customInstrumentId = ''): void {
  const track = createTrack(
    state.project,
    instrument,
    state.project.tracks.length,
    'midi',
    customInstrumentId
  )
  state.project.tracks.push(track)
  state.selectedTrackId = track.id
  state.selectedNoteIds = []
  state.selectedClipId = ''
  record(`新增轨道：${track.name}`)
  commit()
}

/** 新增一条空音频轨（等待录音或导入音频文件填充） */
export function addAudioTrack(): string {
  const track = createTrack(state.project, 'piano', state.project.tracks.length, 'audio')
  state.project.tracks.push(track)
  state.selectedTrackId = track.id
  state.selectedNoteIds = []
  state.selectedClipId = ''
  // 新建音频轨后直接进入波形视图，方便立刻录音或导入
  state.viewMode = 'audio'
  record(`新增轨道：${track.name}`)
  commit()
  return track.id
}

export function removeTrack(id: string): void {
  const index = state.project.tracks.findIndex((t) => t.id === id)
  if (index < 0) return
  const [removed] = state.project.tracks.splice(index, 1)
  // 被删除轨道的采样若已无人引用，同步从 IndexedDB 清掉
  void releaseUnusedPcm(removed.clips.map((c) => c.key))
  // 删除编组时不连带删除子轨：把子轨提升回主干，避免音频突然消失
  for (const track of state.project.tracks) {
    if (track.parentId === removed.id) track.parentId = ''
    // 引用了该轨道作为侧链源的压缩器，解除侧链避免指向不存在的轨道
    for (const effect of track.effects) {
      if (effect.sidechain?.sourceTrackId === removed.id) effect.sidechain = undefined
    }
  }
  if (state.selectedTrackId === id) {
    const nextId = state.project.tracks[Math.min(index, state.project.tracks.length - 1)]?.id ?? ''
    state.selectedTrackId = nextId
    state.selectedNoteIds = []
    state.selectedClipId = ''
    alignViewModeWithTrack(state.project.tracks.find((t) => t.id === nextId))
  }
  record(`删除轨道：${removed.name}`)
  commit()
}

/** 上下排序：dir = -1 上移，1 下移 */
export function moveTrack(id: string, dir: -1 | 1): void {
  const tracks = state.project.tracks
  const index = tracks.findIndex((t) => t.id === id)
  const target = index + dir
  if (index < 0 || target < 0 || target >= tracks.length) return
  const [item] = tracks.splice(index, 1)
  tracks.splice(target, 0, item)
  record('调整轨道顺序')
  commit()
}

export function renameTrack(id: string, name: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.name = name || track.name
  record('重命名轨道')
  commit()
}

/**
 * 切换轨道音色。
 * instrument === 'custom' 时需要同时给出 customInstrumentId，其余音色会清空该字段。
 */
export function setTrackInstrument(
  id: string,
  instrument: InstrumentType,
  customInstrumentId = ''
): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track || track.kind === 'audio') return
  const nextCustomId = instrument === 'custom' ? customInstrumentId : ''
  if (track.instrument === instrument && track.customInstrumentId === nextCustomId) return
  track.instrument = instrument
  track.customInstrumentId = nextCustomId
  const label = resolveInstrumentLabel(instrument, state.project.customInstruments, nextCustomId)
  record(`切换音色：${label}`)
  commit()
}

// ---------------------------------------------------------------- 混音操作

export function setTrackVolume(id: string, volume: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.volume = clamp(volume, 0, 1)
  engine.updateMix(track, state.project.tracks)
  // 自动化写入模式下，推子动作同时落进曲线；返回 true 时历史记录由写入逻辑负责
  if (!maybeWriteAutomation(track, 'volume', track.volume)) {
    record('调整音量', `vol:${id}`)
    persistOnly()
  }
}

export function setTrackPan(id: string, pan: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.pan = clamp(pan, -1, 1)
  engine.updateMix(track, state.project.tracks)
  if (!maybeWriteAutomation(track, 'pan', track.pan)) {
    record('调整声像', `pan:${id}`)
    persistOnly()
  }
}

/** 调整某个均衡频段（dB） */
export function setTrackEq(id: string, band: EqBand, value: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track[band] = clamp(value, EQ_MIN, EQ_MAX)
  engine.setTrackEq(id, band, track[band])
  if (!maybeWriteAutomation(track, band, track[band])) {
    record('调整均衡', `eq:${id}:${band}`)
    persistOnly()
  }
}

/** 调整混响发送量（0~1） */
export function setTrackReverbSend(id: string, value: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.reverbSend = clamp(value, 0, 1)
  engine.setTrackReverbSend(id, track.reverbSend)
  if (!maybeWriteAutomation(track, 'reverbSend', track.reverbSend)) {
    record('调整混响发送', `send:${id}`)
    persistOnly()
  }
}

/** 把某条轨道的均衡与发送一键复位 */
export function resetTrackMix(id: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  const base = track.kind === 'audio' ? DEFAULT_AUDIO_MIX : DEFAULT_MIX
  track.volume = base.volume
  track.pan = base.pan
  track.eqLow = base.eqLow
  track.eqMid = base.eqMid
  track.eqHigh = base.eqHigh
  track.reverbSend = base.reverbSend
  engine.updateMix(track, state.project.tracks)
  record('复位混音')
  persistOnly()
}

export function toggleMute(id: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.mute = !track.mute
  engine.updateAllMix(state.project)
  record(track.mute ? '静音轨道' : '取消静音')
  commit()
}

export function toggleSolo(id: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.solo = !track.solo
  engine.updateAllMix(state.project)
  record(track.solo ? '独奏轨道' : '取消独奏')
  commit()
}

// ---------------------------------------------------------------- 自动化包络

/** 取某参数的静态值（该参数在混音台上的推子值，也是自动化曲线的基准） */
export function automationStaticValue(track: Track, param: AutomationParam): number {
  return track[param]
}

/** 取某条自动化曲线（不存在时返回 undefined） */
export function automationLane(track: Track, param: AutomationParam): AutomationLane | undefined {
  return track.automation.find((lane) => lane.param === param)
}

/** 自动化改动后的统一收尾：通知引擎并记一步历史 */
function finishAutomation(track: Track, label: string, coalesceKey = ''): void {
  engine.updateTrackAutomation(track)
  record(label, coalesceKey)
  commit()
}

/** 切换自动化写入模式（off / touch / latch），供钢琴卷帘工具条调用 */
export function setAutomationWriteMode(mode: AutomationWriteMode): void {
  state.automationWriteMode = mode
}

/** 曲线在某一拍的线性插值（写入前用于「钉住」原值，避免写入起点被斜坡提前拉走） */
function curveValueAt(lane: AutomationLane, beat: number): number {
  const pts = lane.points
  if (pts.length === 0) return 0
  if (beat <= pts[0].beat) return pts[0].value
  for (let i = 1; i < pts.length; i += 1) {
    if (beat <= pts[i].beat) {
      const a = pts[i - 1]
      const b = pts[i]
      const t = b.beat > a.beat ? (beat - a.beat) / (b.beat - a.beat) : 1
      return a.value + (b.value - a.value) * t
    }
  }
  return pts[pts.length - 1].value
}

/**
 * 自动化写入（Touch / Latch）：播放中调整推子 / 旋钮时，把动作实时落进曲线。
 * - touch：只写入已有曲线的参数，不会新建曲线
 * - latch：没有曲线的参数也会从无到有新建一条
 * 返回是否发生了写入（写入时历史记录 / 持久化由本函数负责，调用方跳过自己的 record）。
 */
function maybeWriteAutomation(track: Track, param: AutomationParam, value: number): boolean {
  if (state.automationWriteMode === 'off' || !state.isPlaying) return false
  let lane = automationLane(track, param)
  if (!lane && state.automationWriteMode === 'touch') return false
  const def = AUTOMATION_PARAM_MAP[param]
  const safeValue = clamp(value, def.min, def.max)
  // 先让当前值在播放中立即生效（绕过「有曲线的参数不写静态值」的规则）
  engine.writeParamLive(track.id, param, safeValue)
  const beat = Math.max(0, state.playheadBeats)
  const range = def.max - def.min

  if (!lane) {
    // latch 新建曲线：先落两个几乎重合的点（满足「曲线至少两个点」的归一化规则）
    lane = {
      param,
      points: [
        { id: uid('apt'), beat: Math.max(0, beat - 0.01), value: safeValue },
        { id: uid('apt'), beat, value: safeValue }
      ]
    }
    track.automation.push(lane)
  } else {
    const pts = lane.points
    const last = pts[pts.length - 1]
    const existing = pts.find((p) => Math.abs(p.beat - beat) < 0.005)
    if (beat - last.beat > 0.05 && !existing) {
      // 写入刚从空闲进入活跃：先在当前拍钉住曲线原值，让「此前的形状」保持到写入点
      const held = curveValueAt(lane, beat)
      if (Math.abs(held - last.value) > range * 0.001) {
        pts.push({ id: uid('apt'), beat: Math.max(0, beat - 0.001), value: held })
      }
    }
    if (existing) {
      existing.value = safeValue
    } else {
      const last2 = pts[pts.length - 1]
      // 值变化超过量程 2% 落点；值基本不动时每 0.5 拍补一个平点，把曲线钉平
      if (Math.abs(last2.value - safeValue) > range * 0.02 || beat - last2.beat >= 0.5) {
        pts.push({ id: uid('apt'), beat, value: safeValue })
      }
    }
    pts.sort((a, b) => a.beat - b.beat)
  }

  engine.updateTrackAutomation(track)
  persistOnly()
  record(`写入自动化：${def.label}`, `aw:${track.id}:${param}`)
  commit()
  return true
}

/** 新增一个自动化关键点（同一拍已有则覆盖其数值） */
export function addAutomationPoint(
  trackId: string,
  param: AutomationParam,
  beat: number,
  value: number
): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const def = AUTOMATION_PARAM_MAP[param]
  const safeBeat = Math.max(0, roundBeat(beat))
  const safeValue = clamp(value, def.min, def.max)
  let lane = automationLane(track, param)
  if (!lane) {
    lane = { param, points: [] }
    track.automation.push(lane)
  }
  const exist = lane.points.find((p) => Math.abs(p.beat - safeBeat) < 0.001)
  if (exist) exist.value = safeValue
  else lane.points.push({ id: uid('apt'), beat: safeBeat, value: safeValue })
  lane.points.sort((a, b) => a.beat - b.beat)
  finishAutomation(track, `添加自动化点：${def.label}`)
}

/** 拖动 / 改写一个自动化点（拖拽过程中用同一个 coalesceKey 合并成一步） */
export function moveAutomationPoint(
  trackId: string,
  param: AutomationParam,
  pointId: string,
  beat: number,
  value: number
): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const lane = automationLane(track, param)
  const point = lane?.points.find((p) => p.id === pointId)
  if (!lane || !point) return
  const def = AUTOMATION_PARAM_MAP[param]
  point.beat = Math.max(0, roundBeat(beat))
  point.value = clamp(value, def.min, def.max)
  // 位置变化会打乱顺序，重新排序保证曲线按拍递增
  lane.points.sort((a, b) => a.beat - b.beat)
  finishAutomation(track, `调整自动化：${def.label}`, `apt:${pointId}`)
}

/** 删除一个自动化点；点少于 2 个时整条曲线一并移除 */
export function removeAutomationPoint(
  trackId: string,
  param: AutomationParam,
  pointId: string
): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const lane = automationLane(track, param)
  if (!lane) return
  const index = lane.points.findIndex((p) => p.id === pointId)
  if (index < 0) return
  lane.points.splice(index, 1)
  const def = AUTOMATION_PARAM_MAP[param]
  if (lane.points.length < 2) {
    track.automation = track.automation.filter((l) => l !== lane)
    finishAutomation(track, `清除自动化：${def.label}`)
    return
  }
  finishAutomation(track, `删除自动化点：${def.label}`)
}

/** 清空某参数的自动化曲线，恢复为推子上的静态值 */
export function clearAutomation(trackId: string, param: AutomationParam): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const lane = automationLane(track, param)
  if (!lane) return
  track.automation = track.automation.filter((l) => l !== lane)
  finishAutomation(track, `清除自动化：${AUTOMATION_PARAM_MAP[param].label}`)
}

// ---------------------------------------------------------------- 音阶锁定

/** 切换音阶锁定开关（关闭后写谱恢复自由半音） */
export function toggleScaleLock(): void {
  state.scaleLockOn = !state.scaleLockOn
  state.statusText = state.scaleLockOn ? '音阶锁定已开启' : '音阶锁定已关闭'
}

/** 设置音阶根音 */
export function setScaleRoot(root: number): void {
  state.project.scale = { ...state.project.scale, root: clamp(Math.round(root), 48, 59) }
  record('调整音阶根音')
  persistOnly()
}

/** 设置音阶类型（选到「十二平均律」等价于关闭锁定） */
export function setScaleType(type: ScaleType): void {
  if (!SCALE_DEF_MAP[type]) return
  state.project.scale = { ...state.project.scale, type }
  if (type === 'chromatic') state.scaleLockOn = false
  record(`切换音阶：${SCALE_DEF_MAP[type].label}`)
  persistOnly()
}

/** 把音阶内的合法音高吸附到工程音阶（供钢琴卷帘创建 / 拖动音符时调用） */
export function snapMidi(midi: number): number {
  if (!state.scaleLockOn) return midi
  return snapMidiToScale(midi, state.project.scale)
}

/**
 * 把当前选中的音符一键量化到工程音阶。
 * 返回被修正的音符数量，供界面提示。
 */
export function quantizeSelectedToScale(): number {
  const region = activeRegion()
  if (!region || state.selectedNoteIds.length === 0) return 0
  const ids = new Set(state.selectedNoteIds)
  let count = 0
  for (const note of region.notes) {
    if (!ids.has(note.id)) continue
    const next = quantizeMidiToScale(note.midi, state.project.scale)
    if (next !== note.midi) {
      note.midi = next
      count += 1
    }
  }
  if (count > 0) {
    record('量化到音阶')
    commit()
  }
  return count
}

// ---------------------------------------------------------------- 编组 / Bus

/** 新增一个编组轨（自身不发声，用于汇总子轨并统一处理） */
export function addGroupTrack(): string {
  const track = createTrack(state.project, 'piano', state.project.tracks.length, 'group')
  state.project.tracks.push(track)
  state.selectedTrackId = track.id
  state.selectedNoteIds = []
  state.selectedClipId = ''
  record(`新增编组：${track.name}`)
  commit()
  return track.id
}

/** 判断 candidate 是否为 track 的后代（用于防止把编组拖进自己的子轨里形成环） */
function isDescendant(candidate: string, trackId: string): boolean {
  const byId = new Map(state.project.tracks.map((t) => [t.id, t]))
  let cursor = byId.get(candidate)
  let guard = 0
  while (cursor && cursor.parentId && guard < 512) {
    if (cursor.parentId === trackId) return true
    cursor = byId.get(cursor.parentId)
    guard += 1
  }
  return false
}

/** 把轨道挂到某个编组下（parentId 为空表示移出编组、挂回主干） */
export function setTrackParent(trackId: string, parentId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track || track.id === parentId) return
  if (parentId) {
    const parent = state.project.tracks.find((t) => t.id === parentId)
    if (!parent || parent.kind !== 'group') return
    // 不允许把编组拖进自己的后代，否则信号链会成环
    if (isDescendant(parentId, trackId)) return
  }
  if (track.parentId === parentId) return
  track.parentId = parentId
  record(parentId ? `移入编组：${track.name}` : `移出编组：${track.name}`)
  commit()
}

// ---------------------------------------------------------------- 效果器

/** 把效果器链推给音频引擎（结构变化会重建链路，仅参数变化则原地更新） */
function pushEffects(track: Track): void {
  engine.updateTrackEffects(track)
}

export function addEffect(trackId: string, type: EffectType): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const effect: TrackEffect = {
    id: uid('fx'),
    type,
    enabled: true,
    params: defaultEffectParams(type)
  }
  track.effects.push(effect)
  pushEffects(track)
  record(`添加效果器：${EFFECT_DEF_MAP[type].label}`)
  commit()
}

export function removeEffect(trackId: string, effectId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const index = track.effects.findIndex((e) => e.id === effectId)
  if (index < 0) return
  const [removed] = track.effects.splice(index, 1)
  pushEffects(track)
  record(`移除效果器：${EFFECT_DEF_MAP[removed.type].label}`)
  commit()
}

export function toggleEffect(trackId: string, effectId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  const effect = track?.effects.find((e) => e.id === effectId)
  if (!track || !effect) return
  effect.enabled = !effect.enabled
  pushEffects(track)
  record(effect.enabled ? '启用效果器' : '停用效果器')
  commit()
}

/** 调整效果器参数（拖动滑块时用 coalesceKey 合并成一步） */
export function setEffectParam(trackId: string, effectId: string, key: string, value: number): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  const effect = track?.effects.find((e) => e.id === effectId)
  if (!track || !effect) return
  const def = EFFECT_DEF_MAP[effect.type].params.find((p) => p.key === key)
  if (!def) return
  effect.params[key] = clamp(value, def.min, def.max)
  pushEffects(track)
  record('调整效果器参数', `fx:${trackId}:${effectId}:${key}`)
  persistOnly()
}

/** 重置某个效果器为默认参数 */
export function resetEffect(trackId: string, effectId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  const effect = track?.effects.find((e) => e.id === effectId)
  if (!track || !effect) return
  effect.params = defaultEffectParams(effect.type)
  // 重置时一并解除侧链，避免留下看不见的衰减
  effect.sidechain = undefined
  pushEffects(track)
  record('重置效果器参数')
  commit()
}

/**
 * 设置压缩器的侧链配置。
 * sourceTrackId 传空字符串表示关闭侧链；amount 为最大衰减（dB），release 为恢复时间（秒）。
 */
export function setEffectSidechain(
  trackId: string,
  effectId: string,
  sourceTrackId: string,
  amount: number,
  release: number
): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  const effect = track?.effects.find((e) => e.id === effectId)
  if (!track || !effect || effect.type !== 'compressor') return
  if (!sourceTrackId || sourceTrackId === trackId) {
    effect.sidechain = undefined
  } else {
    effect.sidechain = {
      sourceTrackId,
      amount: clamp(amount, 0, 48),
      release: clamp(release, 0.01, 2)
    }
  }
  pushEffects(track)
  record(effect.sidechain ? '设置侧链压缩' : '关闭侧链压缩')
  commit()
}

/** 调整效果器在链中的顺序（顺序会影响听感） */
export function moveEffect(trackId: string, effectId: string, dir: -1 | 1): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const index = track.effects.findIndex((e) => e.id === effectId)
  const target = index + dir
  if (index < 0 || target < 0 || target >= track.effects.length) return
  const [item] = track.effects.splice(index, 1)
  track.effects.splice(target, 0, item)
  pushEffects(track)
  record('调整效果器顺序')
  commit()
}

export function clearEffects(trackId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track || track.effects.length === 0) return
  track.effects = []
  pushEffects(track)
  record('清空效果器')
  commit()
}

// ---------------------------------------------------------------- 音符操作

/** 工程长度不足时自动扩展小节数（上限 128 小节，防止 Canvas 过宽） */
export function ensureBarsForBeat(beat: number): void {
  const bpb = beatsPerBarOf(state.project.timeSignature)
  const needed = Math.ceil((beat + 1e-6) / bpb)
  if (needed <= state.project.bars) return
  state.project.bars = Math.min(128, needed)
  const total = state.project.bars * bpb
  state.project.tracks.forEach((t) => t.regions.forEach((r) => (r.length = total)))
}

/** 在活动片段中新增一个音符 */
export function addNote(midi: number, start: number, duration: number, velocity = 0.85): Note | null {
  const region = activeRegion()
  if (!region) return null
  const note: Note = {
    id: uid('note'),
    midi,
    start: roundBeat(Math.max(0, start)),
    duration: roundBeat(Math.max(0.0625, duration)),
    velocity
  }
  region.notes.push(note)
  ensureBarsForBeat(note.start + note.duration)
  return note
}

/** 批量删除音符 */
export function removeNotes(ids: string[]): void {
  const region = activeRegion()
  if (!region || ids.length === 0) return
  const set = new Set(ids)
  region.notes = region.notes.filter((n) => !set.has(n.id))
  state.selectedNoteIds = state.selectedNoteIds.filter((id) => !set.has(id))
  record(`删除 ${set.size} 个音符`)
  commit()
}

/** 删除当前选中的音符 */
export function deleteSelectedNotes(): void {
  removeNotes([...state.selectedNoteIds])
}

/**
 * 一键量化：把起始位置对齐网格，同时把时长修正为网格的整数倍。
 * 未选中任何音符时，量化当前片段的全部音符。
 */
export function quantizeSelected(): number {
  const region = activeRegion()
  if (!region) return 0
  const grid = state.snapDivision
  const targets = state.selectedNoteIds.length
    ? region.notes.filter((n) => state.selectedNoteIds.includes(n.id))
    : region.notes
  targets.forEach((note) => {
    note.start = roundBeat(Math.max(0, snapTo(note.start, grid)))
    const snapped = snapTo(note.duration, grid)
    note.duration = roundBeat(Math.max(grid, snapped))
  })
  record(`量化 ${targets.length} 个音符`)
  commit()
  return targets.length
}

export function setNoteSelection(ids: string[]): void {
  state.selectedNoteIds = [...ids]
}

export function toggleNoteSelection(id: string): void {
  const index = state.selectedNoteIds.indexOf(id)
  if (index >= 0) state.selectedNoteIds.splice(index, 1)
  else state.selectedNoteIds.push(id)
}

export function clearNoteSelection(): void {
  state.selectedNoteIds = []
}

/** 全选当前片段中的所有音符 */
export function selectAllNotes(): number {
  const region = activeRegion()
  if (!region) return 0
  state.selectedNoteIds = region.notes.map((n) => n.id)
  return state.selectedNoteIds.length
}

// ------------------------------------------------------------ 力度编辑

/**
 * 当前力度编辑的作用对象：
 * 有选中音符时只作用于选中项，否则作用于当前片段的全部音符
 * （与「量化」的行为保持一致，方便整段快速调整）。
 */
function velocityTargetIds(): string[] {
  if (state.selectedNoteIds.length > 0) return [...state.selectedNoteIds]
  const region = activeRegion()
  return region ? region.notes.map((n) => n.id) : []
}

function notesByIds(ids: string[]): Note[] {
  const region = activeRegion()
  if (!region || ids.length === 0) return []
  const set = new Set(ids)
  return region.notes.filter((n) => set.has(n.id))
}

/** 批量写入力度（绝对 0~1），一次性提交，避免逐音符重排音频 */
export function applyNoteVelocities(entries: { id: string; velocity: number }[]): void {
  if (entries.length === 0) return
  const map = new Map(entries.map((e) => [e.id, clamp(e.velocity, VELOCITY_MIN, VELOCITY_MAX)]))
  const region = activeRegion()
  if (!region) return
  for (const note of region.notes) {
    const value = map.get(note.id)
    if (value !== undefined) note.velocity = value
  }
  record('调整力度', 'velocity')
  commit()
}

/** 把目标音符的力度统一设为某个值（0~1） */
export function setTargetVelocity(velocity: number): number {
  const ids = velocityTargetIds()
  applyNoteVelocities(ids.map((id) => ({ id, velocity })))
  return ids.length
}

/** 力度相对增减（delta 为 0~1 的线性增量，如 ±0.05） */
export function nudgeTargetVelocity(delta: number): number {
  const ids = velocityTargetIds()
  const notes = notesByIds(ids)
  applyNoteVelocities(notes.map((n) => ({ id: n.id, velocity: n.velocity + delta })))
  return notes.length
}

/** 力度按比例缩放（factor 如 0.8 / 1.25） */
export function scaleTargetVelocity(factor: number): number {
  const ids = velocityTargetIds()
  const notes = notesByIds(ids)
  applyNoteVelocities(notes.map((n) => ({ id: n.id, velocity: n.velocity * factor })))
  return notes.length
}

/** 力度人性化：在现有力度上叠加 ±amount 的随机抖动，避免机械感 */
export function humanizeTargetVelocity(amount = 0.1): number {
  const ids = velocityTargetIds()
  const notes = notesByIds(ids)
  applyNoteVelocities(
    notes.map((n) => ({ id: n.id, velocity: n.velocity + (Math.random() * 2 - 1) * amount }))
  )
  return notes.length
}

// ------------------------------------------------------------ 音符精确编辑

/** 修改选中音符的公共属性（音高/起始/时长/力度），供检查器面板使用 */
export function patchSelectedNotes(
  patch: Partial<Pick<Note, 'midi' | 'start' | 'duration' | 'velocity'>>
): void {
  const notes = notesByIds(state.selectedNoteIds)
  if (notes.length === 0) return
  let maxEnd = 0
  for (const note of notes) {
    if (patch.midi !== undefined) note.midi = clamp(Math.round(patch.midi), MIN_MIDI, MAX_MIDI)
    if (patch.start !== undefined) note.start = roundBeat(Math.max(0, patch.start))
    if (patch.duration !== undefined) note.duration = roundBeat(Math.max(0.0625, patch.duration))
    if (patch.velocity !== undefined) note.velocity = clamp(patch.velocity, VELOCITY_MIN, VELOCITY_MAX)
    maxEnd = Math.max(maxEnd, note.start + note.duration)
  }
  ensureBarsForBeat(maxEnd)
  record('修改音符属性')
  commit()
}

/** 把选中音符整体移调（半音） */
export function transposeSelectedNotes(semitones: number): void {
  const notes = notesByIds(state.selectedNoteIds)
  if (notes.length === 0 || semitones === 0) return
  for (const note of notes) {
    note.midi = clamp(note.midi + semitones, MIN_MIDI, MAX_MIDI)
  }
  record(`移调 ${semitones > 0 ? '+' : ''}${semitones} 半音`)
  commit()
}

/** 选中音符的力度整体增减（快捷键使用，delta 为 0~1） */
export function nudgeSelectedVelocity(delta: number): number {
  const notes = notesByIds(state.selectedNoteIds)
  if (notes.length === 0) return 0
  applyNoteVelocities(notes.map((n) => ({ id: n.id, velocity: n.velocity + delta })))
  return notes.length
}

// ------------------------------------------------------------ 复制 / 粘贴

/** 音符剪贴板（仅内存保存，不参与持久化）；start 已归一化为相对第一个音符的偏移 */
let noteClipboard: Note[] = []

/** 复制选中音符到内部剪贴板 */
export function copySelectedNotes(): number {
  const notes = notesByIds(state.selectedNoteIds)
  if (notes.length === 0) return 0
  const origin = Math.min(...notes.map((n) => n.start))
  noteClipboard = notes.map((n) => ({ ...n, start: roundBeat(n.start - origin) }))
  return notes.length
}

/** 剪切选中音符 */
export function cutSelectedNotes(): number {
  const count = copySelectedNotes()
  if (count > 0) deleteSelectedNotes()
  return count
}

/** 把剪贴板内容粘贴到播放头位置（保持音符之间的相对位置） */
export function pasteNotes(): number {
  const region = activeRegion()
  if (!region || noteClipboard.length === 0) return 0
  const base = roundBeat(Math.max(0, state.playheadBeats))
  const created: Note[] = []
  let maxEnd = 0
  for (const item of noteClipboard) {
    const note: Note = { ...item, id: uid('note'), start: roundBeat(base + item.start) }
    region.notes.push(note)
    created.push(note)
    maxEnd = Math.max(maxEnd, note.start + note.duration)
  }
  state.selectedNoteIds = created.map((n) => n.id)
  ensureBarsForBeat(maxEnd)
  record(`粘贴 ${created.length} 个音符`)
  commit()
  return created.length
}

/** 拷贝选中音符：整组紧跟选区末尾平移一份 */
export function duplicateSelectedNotes(): number {
  const region = activeRegion()
  const notes = notesByIds(state.selectedNoteIds)
  if (!region || notes.length === 0) return 0
  const origin = Math.min(...notes.map((n) => n.start))
  const span = Math.max(...notes.map((n) => n.start + n.duration)) - origin
  const created: Note[] = []
  let maxEnd = 0
  for (const n of notes) {
    const note: Note = { ...n, id: uid('note'), start: roundBeat(n.start + span) }
    region.notes.push(note)
    created.push(note)
    maxEnd = Math.max(maxEnd, note.start + note.duration)
  }
  state.selectedNoteIds = created.map((n) => n.id)
  ensureBarsForBeat(maxEnd)
  record(`拷贝 ${created.length} 个音符`)
  commit()
  return created.length
}

// ------------------------------------------------------------ 音频片段

/** 音频片段的时间换算：1 拍 = 60 / bpm 秒 */
function secondsPerBeat(): number {
  return 60 / state.project.bpm
}

/**
 * 判断某个采样键是否还有别的引用（音频片段或自定义音源采样）。
 * 拆分后的片段会共用同一份采样，因此比较时排除正在操作的那一个。
 */
function isPcmKeyStillUsed(key: string, excludeClipId = ''): boolean {
  const inClips = state.project.tracks.some((t) =>
    t.clips.some((c) => c.key === key && c.id !== excludeClipId)
  )
  if (inClips) return true
  return state.project.customInstruments.some((ci) => ci.samples.some((s) => s.key === key))
}

/** 采样不再被任何片段引用时，从 IndexedDB 中删除 */
async function releaseUnusedPcm(keys: string[]): Promise<void> {
  for (const key of keys) {
    if (!isPcmKeyStillUsed(key)) await deletePcm(key)
  }
}

export function selectClip(id: string): void {
  state.selectedClipId = id
}

export function activeClip(): AudioClip | undefined {
  const track = activeTrack()
  if (!track || track.kind !== 'audio') return undefined
  return track.clips.find((c) => c.id === state.selectedClipId) ?? track.clips[0]
}

/** 选中音频轨中指定片段（并切换选中轨道） */
export function selectAudioClip(trackId: string, clipId: string): void {
  state.selectedTrackId = trackId
  state.selectedClipId = clipId
  state.selectedNoteIds = []
  alignViewModeWithTrack(state.project.tracks.find((t) => t.id === trackId))
}

/**
 * 把一段 PCM 采样落成音频片段。
 * 采样写入 IndexedDB，工程 JSON 里只留元信息与降采样峰值。
 */
export async function createClipFromPcm(
  pcm: PcmData,
  startBeat: number,
  name: string,
  targetTrackId = ''
): Promise<string | null> {
  if (pcm.channels.length === 0 || pcm.channels[0].length === 0) return null

  let track = targetTrackId
    ? state.project.tracks.find((t) => t.id === targetTrackId)
    : undefined
  if (!track || track.kind !== 'audio') {
    track = state.project.tracks.find((t) => t.kind === 'audio' && t.id === state.selectedTrackId)
  }
  if (!track) {
    // 没有可用的音频轨就新建一条，保证录音/导入一定落到音频轨上
    const created = createTrack(state.project, 'piano', state.project.tracks.length, 'audio')
    state.project.tracks.push(created)
    track = created
  }

  const sourceSeconds = pcm.channels[0].length / pcm.sampleRate
  const durationBeats = roundBeat(Math.max(0.25, secondsToBeats(sourceSeconds, state.project.bpm)))
  const key = uid('pcm')
  await putPcm(key, pcm)

  const clip: AudioClip = {
    id: uid('clip'),
    name,
    start: roundBeat(Math.max(0, startBeat)),
    duration: durationBeats,
    offset: 0,
    sourceDuration: sourceSeconds,
    sampleRate: pcm.sampleRate,
    key,
    gain: 1,
    fadeIn: 0,
    fadeOut: 0,
    warp: false,
    pitchShift: 0,
    peaks: computePeaks(pcm.channels)
  }

  track.clips.push(clip)
  ensureBarsForBeat(clip.start + clip.duration)
  state.selectedTrackId = track.id
  state.selectedNoteIds = []
  state.selectedClipId = clip.id
  record(`新增音频片段：${name}`)
  commit()
  return clip.id
}

/** 移动片段（拖动改变起始位置） */
export function moveClip(trackId: string, clipId: string, start: number): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return
  clip.start = roundBeat(Math.max(0, start))
  ensureBarsForBeat(clip.start + clip.duration)
  record('移动音频片段', `clip:${clipId}:move`)
  commit()
}

/**
 * 修剪 / 拉伸片段。
 * offset 是相对源音频起点的偏移（秒），duration 是时间轴上的时长（拍），
 * 两者联动，保证不会超出源音频的长度。
 */
export function resizeClip(
  trackId: string,
  clipId: string,
  patch: { start?: number; offset?: number; duration?: number }
): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return

  const spb = secondsPerBeat()
  const minDuration = 0.125
  let offset = patch.offset ?? clip.offset
  let duration = patch.duration ?? clip.duration
  let start = patch.start ?? clip.start

  offset = Math.max(0, Math.min(offset, Math.max(0, clip.sourceDuration - minDuration * spb)))
  // 源音频剩余长度（拍）限制了片段最大时长
  const maxBeats = Math.max(minDuration, (clip.sourceDuration - offset) / spb)
  duration = Math.max(minDuration, Math.min(duration, maxBeats))
  start = Math.max(0, start)

  clip.offset = Math.round(offset * 1000) / 1000
  clip.duration = roundBeat(duration)
  clip.start = roundBeat(start)
  ensureBarsForBeat(clip.start + clip.duration)
  record('修剪音频片段', `clip:${clipId}:trim`)
  commit()
}

/** 片段增益（0~2） */
export function setClipGain(trackId: string, clipId: string, gain: number): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return
  clip.gain = clamp(gain, 0, 2)
  record('调整片段增益', `clip:${clipId}:gain`)
  commit()
}

/**
 * 片段是否 warp 对齐工程速度：
 * 开启后片段按工程速度拉伸（变速不变调补偿，磁带模式），
 * 关闭则按原始速度播放（与工程速度可能不一致）。
 */
export function setClipWarp(trackId: string, clipId: string, warp: boolean): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip || clip.warp === warp) return
  clip.warp = warp
  record(warp ? '开启片段变速对齐' : '关闭片段变速对齐', `clip:${clipId}:warp`)
  commit()
}

/** 片段移调（半音，-24 ~ 24）；0 表示原调 */
export function setClipPitch(trackId: string, clipId: string, semitones: number): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return
  const safe = clamp(Math.round(semitones), -24, 24)
  if (clip.pitchShift === safe) return
  clip.pitchShift = safe
  record(`片段移调：${safe > 0 ? '+' : ''}${safe} 半音`, `clip:${clipId}:pitch`)
  commit()
}

/** 淡入 / 淡出时长（拍） */
export function setClipFade(
  trackId: string,
  clipId: string,
  edge: 'in' | 'out',
  beats: number
): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return
  const value = Math.max(0, Math.min(roundBeat(beats), clip.duration))
  if (edge === 'in') clip.fadeIn = value
  else clip.fadeOut = value
  record('调整淡入淡出', `clip:${clipId}:fade:${edge}`)
  commit()
}

export function renameClip(trackId: string, clipId: string, name: string): void {
  const clip = state.project.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!clip) return
  clip.name = name || clip.name
  record('重命名音频片段')
  commit()
}

/** 删除片段（采样若无人引用则一并清理） */
export function removeClip(trackId: string, clipId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  if (!track) return
  const index = track.clips.findIndex((c) => c.id === clipId)
  if (index < 0) return
  const [removed] = track.clips.splice(index, 1)
  if (state.selectedClipId === clipId) state.selectedClipId = track.clips[0]?.id ?? ''
  void releaseUnusedPcm([removed.key])
  record('删除音频片段')
  commit()
}

/** 在指定位置把片段一分为二 */
export function splitClip(trackId: string, clipId: string, beat: number): boolean {
  const track = state.project.tracks.find((t) => t.id === trackId)
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!track || !clip) return false
  const local = beat - clip.start
  if (local <= 0.0625 || local >= clip.duration - 0.0625) return false

  const spb = secondsPerBeat()
  const right: AudioClip = {
    ...clip,
    id: uid('clip'),
    name: `${clip.name} B`,
    start: roundBeat(clip.start + local),
    duration: roundBeat(clip.duration - local),
    offset: Math.round((clip.offset + local * spb) * 1000) / 1000,
    // 拆分后两段共用同一份采样与峰值，因此采样键保持不变
    peaks: clip.peaks
  }
  clip.duration = roundBeat(local)
  clip.name = `${clip.name} A`
  track.clips.push(right)
  state.selectedClipId = right.id
  record('拆分音频片段')
  commit()
  return true
}

/** 复制片段（共用同一份采样，不重复占存储） */
export function duplicateClip(trackId: string, clipId: string): void {
  const track = state.project.tracks.find((t) => t.id === trackId)
  const clip = track?.clips.find((c) => c.id === clipId)
  if (!track || !clip) return
  const copy: AudioClip = {
    ...clip,
    id: uid('clip'),
    name: `${clip.name} 副本`,
    start: roundBeat(clip.start + clip.duration)
  }
  track.clips.push(copy)
  ensureBarsForBeat(copy.start + copy.duration)
  state.selectedClipId = copy.id
  record('复制音频片段')
  commit()
}

// ------------------------------------------------------------ 录音 / 音频导入

/** 开始录音：从当前播放头位置走带，同时采集麦克风 */
export async function beginRecording(): Promise<void> {
  if (state.recording) return
  await ensureAudio()
  try {
    state.recordingStartBeat = roundBeat(Math.max(0, state.playheadBeats))
    await startRecording()
  } catch (error) {
    state.statusText = `录音失败：${(error as Error).message}`
    return
  }
  state.recording = true
  state.recordingSeconds = 0
  state.statusText = '录音中…'

  if (!engine.isPlaying) {
    applyProjectToEngine()
    // 录音不走预备拍，否则预备拍的点击声会被一起录进去
    engine.setMetronome(state.metronomeOn, false)
    engine.syncTracks(state.project)
    engine.scheduleProject(state.project)
    engine.updateAllMix(state.project)
    await engine.play()
    state.isPlaying = true
  }
}

/** 结束录音：停止走带，把采集到的采样落成音频片段 */
export async function endRecording(): Promise<void> {
  if (!state.recording) return
  const startBeat = state.recordingStartBeat
  const pcm = await stopRecording()
  state.recording = false
  state.recordingSeconds = 0
  pause()
  // 恢复工程原本的预备拍设置
  applyProjectToEngine()

  if (!pcm) {
    state.statusText = '录音未采集到有效音频'
    return
  }
  const clipId = await createClipFromPcm(pcm, startBeat, `录音 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
  state.statusText = clipId ? '录音完成，已生成音频片段' : '录音失败：采样为空'
}

/** 录音开关（工具栏按钮使用） */
export async function toggleRecording(): Promise<void> {
  if (state.recording) await endRecording()
  else await beginRecording()
}

/** 导入音频文件为新的音频片段 */
export async function importAudioFile(file: File): Promise<void> {
  await ensureAudio()
  state.busy = true
  state.statusText = '正在解析音频文件…'
  try {
    const pcm = await decodeAudioFile(file)
    const start = roundBeat(Math.max(0, state.playheadBeats))
    const name = file.name.replace(/\.[^.]+$/, '')
    const clipId = await createClipFromPcm(pcm, start, name || '导入音频')
    state.statusText = clipId ? `已导入音频：${name}` : '导入失败：音频为空'
  } catch (error) {
    state.statusText = `导入音频失败：${(error as Error).message}`
  } finally {
    state.busy = false
  }
}

/** 当前是否正在录音（供界面绑定） */
export function recordingActive(): boolean {
  return state.recording && isRecording()
}

/** 片段采样是否已就绪（未就绪时波形不可播放） */
export function isClipPlayable(clip: AudioClip): boolean {
  return getCachedPcm(clip.key) !== null
}

/** 试听当前选中的音频片段（波形编辑器的「试听」按钮调用） */
export async function previewActiveClip(): Promise<void> {
  const clip = activeClip()
  const track = activeTrack()
  if (!clip || !track || track.kind !== 'audio') return
  await ensureAudio()
  if (!isClipPlayable(clip)) {
    state.statusText = '音频采样尚未就绪，请稍候再试'
    return
  }
  engine.previewClip(track.id, clip.key, clip.offset, clip.duration * secondsPerBeat())
}

// ------------------------------------------------------------ 自定义音源

/** 自定义音源默认音号：鼓组用底鼓（36），旋律用中央 C（60） */
const DEFAULT_DRUM_MIDI = 36
const DEFAULT_ROOT_MIDI = 60
/** GM 鼓件音号顺序：新增鼓采样时自动挑一个尚未占用的音号 */
const DRUM_MIDI_ORDER = [
  36, 38, 42, 46, 39, 40, 41, 43, 45, 47, 48, 50, 49, 51, 52, 53, 54, 55, 56, 57, 59, 35, 37, 44
]

function findCustomInstrument(id: string): CustomInstrument | undefined {
  return state.project.customInstruments.find((c) => c.id === id)
}

/** 新建一套自定义音源，返回其 id */
export function addCustomInstrument(name: string, kind: CustomInstrumentKind): string {
  const now = Date.now()
  const custom: CustomInstrument = {
    id: uid('csnd'),
    name: name.trim() || (kind === 'drum' ? '自定义鼓组' : '自定义音色'),
    kind,
    gain: 1,
    samples: [],
    createdAt: now,
    updatedAt: now
  }
  state.project.customInstruments.push(custom)
  record(`新建自定义音源：${custom.name}`)
  commit()
  return custom.id
}

export function renameCustomInstrument(id: string, name: string): void {
  const custom = findCustomInstrument(id)
  if (!custom) return
  const next = name.trim()
  if (!next || next === custom.name) return
  custom.name = next
  custom.updatedAt = Date.now()
  record('重命名自定义音源')
  commit()
}

export function setCustomInstrumentKind(id: string, kind: CustomInstrumentKind): void {
  const custom = findCustomInstrument(id)
  if (!custom || custom.kind === kind) return
  custom.kind = kind
  // 旋律采样原本没有「音号」概念，切到鼓组时按 GM 顺序重新分配冲突的音号，
  // 避免多个采样挤在同一个音号上导致命中不到
  if (kind === 'drum') {
    const used = new Set<number>()
    for (const sample of custom.samples) {
      if (used.has(sample.midi)) {
        sample.midi = DRUM_MIDI_ORDER.find((m) => !used.has(m)) ?? sample.midi
      }
      used.add(sample.midi)
    }
  }
  custom.updatedAt = Date.now()
  record('修改自定义音源类型')
  commit()
}

export function setCustomInstrumentGain(id: string, gain: number): void {
  const custom = findCustomInstrument(id)
  if (!custom) return
  custom.gain = clamp(gain, 0, 2)
  custom.updatedAt = Date.now()
  record('调整自定义音源增益', `csnd:${id}:gain`)
  commit()
}

/** 给鼓组音源挑一个尚未占用的 GM 音号 */
function nextFreeDrumMidi(custom: CustomInstrument): number {
  const used = new Set(custom.samples.map((s) => s.midi))
  return DRUM_MIDI_ORDER.find((m) => !used.has(m)) ?? DEFAULT_DRUM_MIDI
}

/**
 * 往自定义音源里添加一个采样。
 * 采样 PCM 写入 IndexedDB，工程 JSON 只保留元信息。
 */
export async function addCustomSample(
  instrumentId: string,
  pcm: PcmData,
  name: string,
  opts: { midi?: number; rootMidi?: number; gain?: number } = {}
): Promise<string | null> {
  const custom = findCustomInstrument(instrumentId)
  if (!custom || pcm.channels.length === 0 || pcm.channels[0].length === 0) return null
  const key = uid('pcm')
  await putPcm(key, pcm)
  const duration = pcm.channels[0].length / pcm.sampleRate
  const rootMidi = clamp(Math.round(opts.rootMidi ?? DEFAULT_ROOT_MIDI), MIN_MIDI, MAX_MIDI)
  const defaultMidi = custom.kind === 'drum' ? nextFreeDrumMidi(custom) : rootMidi
  const sample: CustomSample = {
    id: uid('smp'),
    name: name.trim() || (custom.kind === 'drum' ? drumNoteLabel(defaultMidi) : '采样'),
    key,
    rootMidi,
    midi: clamp(Math.round(opts.midi ?? defaultMidi), MIN_MIDI, MAX_MIDI),
    gain: clamp(opts.gain ?? 1, 0, 2),
    duration
  }
  custom.samples.push(sample)
  custom.updatedAt = Date.now()
  record(`添加采样：${sample.name}`)
  commit()
  return sample.id
}

/** 修改采样元信息（名称 / 音号 / 原始音高 / 增益） */
export function updateCustomSample(
  instrumentId: string,
  sampleId: string,
  patch: Partial<Pick<CustomSample, 'name' | 'midi' | 'rootMidi' | 'gain'>>
): void {
  const custom = findCustomInstrument(instrumentId)
  const sample = custom?.samples.find((s) => s.id === sampleId)
  if (!custom || !sample) return
  if (patch.name !== undefined) sample.name = patch.name.trim() || sample.name
  if (patch.midi !== undefined) sample.midi = clamp(Math.round(patch.midi), MIN_MIDI, MAX_MIDI)
  if (patch.rootMidi !== undefined) {
    sample.rootMidi = clamp(Math.round(patch.rootMidi), MIN_MIDI, MAX_MIDI)
  }
  if (patch.gain !== undefined) sample.gain = clamp(patch.gain, 0, 2)
  custom.updatedAt = Date.now()
  record('修改采样设置', `smp:${sampleId}`)
  commit()
}

/** 删除一个采样（采样若无人引用则一并从 IndexedDB 清掉） */
export async function removeCustomSample(instrumentId: string, sampleId: string): Promise<void> {
  const custom = findCustomInstrument(instrumentId)
  if (!custom) return
  const index = custom.samples.findIndex((s) => s.id === sampleId)
  if (index < 0) return
  const [removed] = custom.samples.splice(index, 1)
  custom.updatedAt = Date.now()
  if (!isPcmKeyStillUsed(removed.key)) await deletePcm(removed.key)
  record(`删除采样：${removed.name}`)
  commit()
}

/** 删除整套自定义音源：引用它的轨道回退到内置钢琴，避免出现静音轨道 */
export async function removeCustomInstrument(id: string): Promise<void> {
  const index = state.project.customInstruments.findIndex((c) => c.id === id)
  if (index < 0) return
  const [removed] = state.project.customInstruments.splice(index, 1)
  for (const track of state.project.tracks) {
    if (track.instrument === 'custom' && track.customInstrumentId === id) {
      track.instrument = 'piano'
      track.customInstrumentId = ''
    }
  }
  for (const sample of removed.samples) {
    if (!isPcmKeyStillUsed(sample.key)) await deletePcm(sample.key)
  }
  record(`删除自定义音源：${removed.name}`)
  commit()
}

/** 导入一个音频文件作为自定义音源采样 */
export async function importCustomSampleFile(instrumentId: string, file: File): Promise<void> {
  await ensureAudio()
  state.busy = true
  state.statusText = '正在解析采样文件…'
  try {
    const pcm = await decodeAudioFile(file)
    const name = file.name.replace(/\.[^.]+$/, '')
    const id = await addCustomSample(instrumentId, pcm, name)
    state.statusText = id ? `已添加采样：${name}` : '添加采样失败：音频为空'
  } catch (error) {
    state.statusText = `添加采样失败：${(error as Error).message}`
  } finally {
    state.busy = false
  }
}

/** 试听一个自定义音源采样（按原始音高原速播放） */
export async function previewCustomSample(key: string): Promise<void> {
  await ensureAudio()
  engine.previewSample(key)
}

/**
 * 打开「乐器与音源」管理器。
 * tab 用于指定进入时展示的页签：内置乐器 / 自定义音源。
 */
export function openInstrumentManager(tab: InstrumentManagerTab = 'builtin'): void {
  state.instrumentTab = tab
  state.instrumentOpen = true
}

export function closeInstrumentManager(): void {
  state.instrumentOpen = false
  // 关窗时立刻收掉试听声音，避免管理器关闭后还在响
  engine.stopAudition()
}

/** 切换管理器页签（页签指示块动画由组件侧驱动） */
export function setInstrumentTab(tab: InstrumentManagerTab): void {
  state.instrumentTab = tab
}

/**
 * 试听一个音色：内置音色直接播放示范乐句，
 * 自定义音源按其采样播放（鼓组打一小段鼓点，旋律走分解和弦）。
 * quick = true 时播放更短的乐句，供「依次试听全部音色」连播使用。
 */
export async function previewInstrument(
  type: InstrumentType,
  customInstrumentId = '',
  quick = false
): Promise<void> {
  await ensureAudio()
  engine.previewVoice(type, state.project, customInstrumentId, quick)
}

/** 停止正在播放的试听声音（关闭管理器或中断连播时调用） */
export function stopInstrumentPreview(): void {
  engine.stopAudition()
}

/**
 * 把音色应用到当前选中的 MIDI 轨道。
 * 返回 false 表示当前没有可用的 MIDI 轨道（例如选中的是音频轨）。
 */
export function applyInstrumentToActiveTrack(
  type: InstrumentType,
  customInstrumentId = ''
): boolean {
  const track = activeTrack()
  if (!track || track.kind !== 'midi') return false
  setTrackInstrument(track.id, type, customInstrumentId)
  return true
}

// ------------------------------------------------------------ 工程级设置

export function setBpm(bpm: number): void {
  state.project.bpm = clamp(Math.round(bpm), 40, 200)
  engine.setBpm(state.project.bpm)
  record('调整速度')
  commit()
}

// ------------------------------------------------------------ 速度自动化

/** 当前播放头位置的速度（速度曲线插值） */
export function bpmAtPlayhead(): number {
  return bpmAtBeat(state.playheadBeats, state.project.tempoPoints, state.project.bpm)
}

/** 新增速度点；位置 ≈ 第 0 拍时等价于直接修改工程速度 */
export function addTempoPoint(beat: number, bpm: number): void {
  const safeBpm = clamp(Math.round(bpm), 40, 200)
  const safeBeat = roundBeat(beat)
  if (safeBeat <= 0.001) {
    setBpm(safeBpm)
    return
  }
  if (state.project.tempoPoints.some((p) => Math.abs(p.beat - safeBeat) < 0.001)) {
    state.statusText = '该位置已有速度点'
    return
  }
  state.project.tempoPoints.push({ id: uid('tmp'), beat: safeBeat, bpm: safeBpm })
  state.project.tempoPoints.sort((a, b) => a.beat - b.beat)
  engine.setTempoMap(state.project.tempoPoints, state.project.bpm)
  record(`添加速度点：第 ${safeBeat} 拍 ${safeBpm} BPM`)
  commit()
}

/** 调整速度点的位置或速度（拖拽时用同一 coalesceKey 合并历史） */
export function updateTempoPoint(id: string, beat: number, bpm: number): void {
  const point = state.project.tempoPoints.find((p) => p.id === id)
  if (!point) return
  point.beat = Math.max(0.001, roundBeat(beat))
  point.bpm = clamp(Math.round(bpm), 40, 200)
  state.project.tempoPoints.sort((a, b) => a.beat - b.beat)
  engine.setTempoMap(state.project.tempoPoints, state.project.bpm)
  record('调整速度点', `tmp:${id}`)
  commit()
}

/** 删除速度点（第 0 拍速度回到工程 BPM，不可删除） */
export function removeTempoPoint(id: string): void {
  const index = state.project.tempoPoints.findIndex((p) => p.id === id)
  if (index < 0) return
  state.project.tempoPoints.splice(index, 1)
  engine.setTempoMap(state.project.tempoPoints, state.project.bpm)
  record('删除速度点')
  commit()
}

export function setTimeSignature(ts: TimeSignature): void {
  if (state.project.timeSignature === ts) return
  state.project.timeSignature = ts
  engine.setTimeSignature(ts)
  const total = state.project.bars * beatsPerBarOf(ts)
  state.project.tracks.forEach((t) => t.regions.forEach((r) => (r.length = total)))
  record(`切换拍号：${ts}`)
  commit()
}

export function setMasterVolume(volume: number): void {
  state.project.masterVolume = clamp(volume, 0, 1)
  engine.setMasterVolume(state.project.masterVolume)
  record('调整总音量', 'master:vol')
  persistOnly()
}

/** 混响返回量（共享混响总线送回主输出的电平） */
export function setReverbWet(wet: number): void {
  state.project.reverbWet = clamp(wet, 0, 1)
  engine.setReverbWet(state.project.reverbWet)
  record('调整混响返回', 'master:wet')
  persistOnly()
}

/** 总线限幅阈值（dB） */
export function setLimiterThreshold(db: number): void {
  state.project.masterLimiter = clamp(db, LIMITER_MIN, LIMITER_MAX)
  engine.setLimiterThreshold(state.project.masterLimiter)
  record('调整限幅阈值', 'master:lim')
  persistOnly()
}

export function setSnapDivision(division: GridDivision): void {
  state.snapDivision = division
}

/** 切换中央编辑区视图：钢琴卷帘 / 混音台 */
export function setViewMode(mode: ViewMode): void {
  state.viewMode = mode
}

/** 展开 / 收起钢琴卷帘底部的力度编辑条 */
export function toggleVelocityLane(): void {
  state.velocityLaneOn = !state.velocityLaneOn
  writeUiPrefs()
}

/** 切换「按力度着色」显示 */
export function toggleNoteColor(): void {
  state.noteColorByVelocity = !state.noteColorByVelocity
  writeUiPrefs()
}

/** 切换底部自动化包络编辑条 */
export function toggleAutomationLane(): void {
  state.automationLaneOn = !state.automationLaneOn
}

/** 切换当前正在编辑的自动化参数 */
export function setAutomationParam(param: AutomationParam): void {
  if (!AUTOMATION_PARAM_MAP[param]) return
  state.automationParam = param
}

/** 设置虚拟键盘 / 试听力度（0~1） */
export function setKeyboardVelocity(velocity: number): void {
  state.keyboardVelocity = clamp(velocity, VELOCITY_MIN, VELOCITY_MAX)
}

/** 切换音量读数单位：dB ↔ 线性百分比（全局生效，仅影响显示） */
export function toggleVolumeDisplay(): void {
  state.volumeDisplay = state.volumeDisplay === 'db' ? 'linear' : 'db'
  writeUiPrefs()
}

/** 功能开关清单：键 / 名称 / 说明，设置页据此渲染勾选项 */
export const FEATURE_FLAGS: { key: FeatureKey; label: string; desc: string }[] = [
  { key: 'metronome', label: '节拍器', desc: '顶栏节拍器开关按钮' },
  { key: 'countIn', label: '预备拍', desc: '播放前一小节预备拍按钮' },
  { key: 'markers', label: '标点工具', desc: '顶栏打点 / 跳转 / 自动卡点按钮组' },
  { key: 'midi', label: 'MIDI 输入', desc: '顶栏「♪」录制待命按钮与设置页 MIDI 设备区' }
]

/** 切换某个界面功能的启用状态（仅影响界面，不进入工程历史） */
export function toggleFeature(key: FeatureKey): void {
  state.featureToggles[key] = !state.featureToggles[key]
  // 关闭 MIDI 输入时同步取消录制待命，避免隐藏的按钮仍保持录制状态
  if (key === 'midi' && !state.featureToggles.midi) state.midiRecordArmed = false
  writeUiPrefs()
}

/** 设备模式的联动效果（切换与启动恢复共用，保证刷新后观感一致） */
function applyDeviceModeEffects(): void {
  // Pad 模式下自动加大行高，方便手指点击
  if (state.deviceMode === 'pad' && state.view.rowHeight < 20) state.view.rowHeight = 22
}

/** 切换设备模式（pc / pad），切换后整体布局与交互方式都会调整 */
export function setDeviceMode(mode: DeviceMode): void {
  state.deviceMode = mode
  applyDeviceModeEffects()
  writeUiPrefs()
}

/** 打开设置对话框 */
export function openSettings(): void {
  state.settingsOpen = true
}

/** 关闭设置对话框 */
export function closeSettings(): void {
  state.settingsOpen = false
}

/** 设置长按触发时长（ms），仅在 Pad 模式下用于框选和右键菜单 */
export function setLongPressDuration(ms: number): void {
  state.longPressDuration = Math.max(150, Math.min(2000, ms))
  writeUiPrefs()
}

/** 切换 Pad 端虚拟键盘是否常驻显示 */
export function toggleTouchKeyboardAlwaysOn(): void {
  state.touchKeyboardAlwaysOn = !state.touchKeyboardAlwaysOn
  writeUiPrefs()
}

export function toggleMetronome(): void {
  state.metronomeOn = !state.metronomeOn
  engine.setMetronome(state.metronomeOn, state.countInOn)
  persistOnly()
}

export function toggleCountIn(): void {
  state.countInOn = !state.countInOn
  engine.setMetronome(state.metronomeOn, state.countInOn)
  persistOnly()
}

export function toggleLoop(): void {
  state.loopOn = !state.loopOn
  engine.setLoop(state.loopOn)
  persistOnly()
}

export function renameProject(name: string): void {
  state.project.name = name || state.project.name
  record('重命名工程')
  persistOnly()
}

// ---------------------------------------------------------------- 播放控制

/** 首次用户手势时激活音频上下文 */
export async function ensureAudio(): Promise<void> {
  if (state.audioReady) return
  await engine.ensureReady()
  state.audioReady = true
  // 引擎链路刚构建时用的是默认值，这里把工程里保存的混音参数补上
  applyProjectToEngine()
  syncNow()
  await hydrateAudio()
}

export async function play(): Promise<void> {
  await ensureAudio()
  applyProjectToEngine()
  engine.syncTracks(state.project)
  engine.scheduleProject(state.project)
  engine.updateAllMix(state.project)
  state.isCountingIn = state.countInOn && engine.getBeats() < 0.001
  await engine.play()
  state.isPlaying = true
}

export function pause(): void {
  // 暂停时把还没抬起的 MIDI 录音音符结算掉，避免恢复播放后时长被拉长
  settleAllPendingMidi()
  engine.pause()
  state.isPlaying = false
  state.isCountingIn = false
}

export function stop(): void {
  settleAllPendingMidi()
  engine.stop()
  state.isPlaying = false
  state.isCountingIn = false
  state.playheadBeats = 0
}

export async function togglePlay(): Promise<void> {
  if (engine.isPlaying) pause()
  else await play()
}

export function seek(beats: number): void {
  const total = engine.projectLengthBeats(state.project)
  engine.seek(clamp(beats, 0, total))
  state.playheadBeats = engine.getBeats()
}

// ------------------------------------------------------------ MIDI 硬件输入录制

/** 进行中的 MIDI 录音音符：等待 note off 结算时长 */
interface PendingMidiNote {
  noteId: string
  region: Region
}

/** 键为 MIDI 音号；同一音号重复按下时以最后一次为准 */
const pendingMidiNotes = new Map<number, PendingMidiNote>()

/** 切换 MIDI 录制待命（armed）：取消待命时结算所有未抬起的音符 */
export function toggleMidiRecordArmed(): void {
  state.midiRecordArmed = !state.midiRecordArmed
  if (!state.midiRecordArmed) settleAllPendingMidi()
}

/**
 * MIDI 硬件 note on：先试听当前轨道音色；
 * 待命时把音符写进当前轨道（时长先给最小值，note off 后按播放头结算）。
 */
export function handleMidiNoteOn(midi: number, velocity: number): void {
  const track = activeTrack()
  if (!track || track.kind !== 'midi') return
  const safeMidi = clamp(Math.round(midi), MIN_MIDI, MAX_MIDI)
  previewAttack(track.id, safeMidi, clamp(velocity, 0.05, 1))
  if (!state.midiRecordArmed) return
  const region = activeRegion()
  if (!region) return
  const note: Note = {
    id: uid('note'),
    midi: safeMidi,
    start: Math.max(0, state.playheadBeats),
    duration: 0.25,
    velocity: clamp(velocity, VELOCITY_MIN, VELOCITY_MAX)
  }
  region.notes.push(note)
  ensureBarsForBeat(note.start + note.duration)
  pendingMidiNotes.set(midi, { noteId: note.id, region })
  commit()
}

/** MIDI 硬件 note off：按当前播放头结算音符时长 */
export function handleMidiNoteOff(midi: number): void {
  const pending = pendingMidiNotes.get(midi)
  if (!pending) return
  pendingMidiNotes.delete(midi)
  const note = pending.region.notes.find((n) => n.id === pending.noteId)
  if (!note) return
  const end = Math.max(note.start + 0.125, state.playheadBeats)
  note.duration = roundBeat(end - note.start)
  ensureBarsForBeat(note.start + note.duration)
  record(`MIDI 录入：${midiToNoteName(midi)}`, 'midiRec')
  commit()
}

/** 播放停止 / 暂停 / 取消待命时，结算所有尚未抬起的录音音符 */
function settleAllPendingMidi(): void {
  if (pendingMidiNotes.size === 0) return
  const end = Math.max(0, state.playheadBeats)
  for (const pending of pendingMidiNotes.values()) {
    const note = pending.region.notes.find((n) => n.id === pending.noteId)
    if (!note) continue
    note.duration = roundBeat(Math.max(note.start + 0.125, end) - note.start)
    ensureBarsForBeat(note.start + note.duration)
  }
  pendingMidiNotes.clear()
  record('MIDI 录入', 'midiRec')
  commit()
}

// ---------------------------------------------------------------- 时间轴标记点（标点 / 卡点）

/** 添加标记点（默认打在播放头位置），label 为空时自动编号 */
export function addMarker(beat = state.playheadBeats, label = ''): void {
  const safeBeat = Math.max(0, roundBeat(beat))
  // 同一位置已有标记时不重复添加
  if (state.project.markers.some((m) => Math.abs(m.beat - safeBeat) < 0.001)) {
    state.statusText = '该位置已有标记点'
    return
  }
  if (state.project.markers.length >= MAX_MARKERS) {
    state.statusText = `标记点已达上限（${MAX_MARKERS} 个）`
    return
  }
  const marker: TimelineMarker = {
    id: uid('mk'),
    beat: safeBeat,
    label: label || `标记 ${state.project.markers.length + 1}`
  }
  state.project.markers.push(marker)
  state.project.markers.sort((a, b) => a.beat - b.beat)
  state.selectedMarkerId = marker.id
  ensureBarsForBeat(safeBeat)
  record('添加标记点')
  commit()
  state.statusText = `已添加标记点：第 ${safeBeat.toFixed(2)} 拍`
}

/** 删除标记点 */
export function removeMarker(id: string): void {
  const index = state.project.markers.findIndex((m) => m.id === id)
  if (index < 0) return
  state.project.markers.splice(index, 1)
  if (state.selectedMarkerId === id) state.selectedMarkerId = ''
  record('删除标记点')
  commit()
  state.statusText = '已删除标记点'
}

/** 移动标记点（拖拽过程中用同一个 coalesceKey 合并成一步） */
export function moveMarker(id: string, beat: number): void {
  const marker = state.project.markers.find((m) => m.id === id)
  if (!marker) return
  const safeBeat = Math.max(0, roundBeat(beat))
  if (Math.abs(marker.beat - safeBeat) < 0.001) return
  marker.beat = safeBeat
  // 位置变化会打乱顺序，重新排序保证按拍递增
  state.project.markers.sort((a, b) => a.beat - b.beat)
  ensureBarsForBeat(safeBeat)
  record('移动标记点', `marker:${id}:move`)
  commit()
}

/** 重命名标记点 */
export function renameMarker(id: string, label: string): void {
  const marker = state.project.markers.find((m) => m.id === id)
  if (!marker) return
  const next = label.trim()
  if (!next || next === marker.label) return
  marker.label = next
  record('重命名标记点')
  commit()
}

/** 清空全部标记点 */
export function clearMarkers(): void {
  const count = state.project.markers.length
  if (!count) return
  state.project.markers = []
  state.selectedMarkerId = ''
  record('清空标记点')
  commit()
  state.statusText = `已清空 ${count} 个标记点`
}

/** 跳转到指定标记点 */
export function seekMarker(id: string): void {
  const marker = state.project.markers.find((m) => m.id === id)
  if (!marker) return
  state.selectedMarkerId = id
  seek(marker.beat)
}

/** 跳到上一个 / 下一个标记点（dir = -1 / 1），到端点时回绕 */
export function gotoMarker(dir: 1 | -1): void {
  const list = state.project.markers
  if (!list.length) {
    state.statusText = '当前工程还没有标记点'
    return
  }
  const current = state.playheadBeats
  // 留一点容差，避免刚好停在标记点上时反复跳到自身
  const eps = 0.01
  const before = list.filter((m) => m.beat < current - eps)
  const after = list.filter((m) => m.beat > current + eps)
  const target = dir === 1 ? after[0] ?? list[0] : before[before.length - 1] ?? list[list.length - 1]
  seekMarker(target.id)
}

/**
 * 自动卡点：从音频轨的波形峰值里检测重音位置，批量生成标记点。
 *
 * 采用「能量包络 + 正向差分」的轻量 onset 检测，不依赖任何外部库：
 *   1. 把每个片段的降采样峰值取绝对值，得到能量包络；
 *   2. 求相邻帧的正向差分（起音瞬间能量骤增 → 出现正峰值）；
 *   3. 用自适应阈值（均值 × 系数）过滤，并做最小时间间隔限制，避免密集误检；
 *   4. 把源音频内的秒数换算成工程时间轴上的拍数。
 * 结果只是数据，不影响播放与导出，可随时撤销。
 *
 * @param thresholdScale 阈值系数，越大越严格（默认 1.4）
 * @param minGapSeconds  两个卡点之间的最小间隔（秒，默认 0.18）
 * @returns 本次新增的标记点数量
 */
export function detectMarkers(thresholdScale = 1.4, minGapSeconds = 0.18): number {
  const spb = secondsPerBeat()
  const found: number[] = []
  for (const track of state.project.tracks) {
    for (const clip of track.clips) collectOnsets(clip, spb, thresholdScale, minGapSeconds, found)
  }
  if (!found.length) {
    state.statusText = '没有检测到明显的重音，换个音频片段再试'
    return 0
  }
  // 合并去重：跨轨道的同一位置只保留一个，并限制最小间隔
  found.sort((a, b) => a - b)
  const unique: number[] = []
  const minGapBeats = minGapSeconds / spb
  for (const beat of found) {
    const last = unique[unique.length - 1]
    if (last !== undefined && beat - last < minGapBeats) continue
    unique.push(beat)
  }
  // 已有标记点的位置跳过，并受总量上限约束
  const room = Math.max(0, MAX_MARKERS - state.project.markers.length)
  const accepted = unique
    .filter((beat) => !state.project.markers.some((m) => Math.abs(m.beat - beat) < 0.02))
    .slice(0, room)
  if (!accepted.length) {
    state.statusText = '检测到的卡点都已存在'
    return 0
  }
  for (const beat of accepted) {
    state.project.markers.push({
      id: uid('mk'),
      beat,
      label: `卡点 ${state.project.markers.length + 1}`
    })
  }
  state.project.markers.sort((a, b) => a.beat - b.beat)
  const lastMarker = state.project.markers[state.project.markers.length - 1]
  if (lastMarker) ensureBarsForBeat(lastMarker.beat)
  record('自动卡点')
  commit()
  state.statusText = `自动卡点完成：新增 ${accepted.length} 个标记点`
  return accepted.length
}

/** 单个音频片段的重音检测：把命中的位置（拍）追加到 out */
function collectOnsets(
  clip: AudioClip,
  spb: number,
  thresholdScale: number,
  minGapSeconds: number,
  out: number[]
): void {
  const buckets = Math.floor(clip.peaks.length / 2)
  if (buckets < 8 || clip.sourceDuration <= 0 || clip.duration <= 0) return

  // 1. 能量包络：每个桶取 |min| / |max| 中的较大值
  const energy = new Float32Array(buckets)
  for (let i = 0; i < buckets; i += 1) {
    energy[i] = Math.max(Math.abs(clip.peaks[i * 2]), Math.abs(clip.peaks[i * 2 + 1]))
  }

  // 2. 正向差分：只保留能量上升的部分，得到起音强度曲线
  const flux = new Float32Array(buckets)
  let sum = 0
  for (let i = 1; i < buckets; i += 1) {
    const delta = energy[i] - energy[i - 1]
    flux[i] = delta > 0 ? delta : 0
    sum += flux[i]
  }
  // 静音片段不会有明显起音，直接跳过
  const mean = sum / Math.max(1, buckets - 1)
  if (mean < 1e-4) return
  const threshold = mean * thresholdScale

  // 3. 阈值 + 最小间隔（桶数）
  const secondsPerBucket = clip.sourceDuration / buckets
  const minGapBuckets = Math.max(1, Math.round(minGapSeconds / secondsPerBucket))
  // 片段在时间轴上「源音频 0 秒」对应的拍号位置（片段起点前移 offset 秒）
  const clipSourceOriginBeat = clip.start - clip.offset / spb
  let lastIndex = -minGapBuckets

  for (let i = 1; i < buckets; i += 1) {
    const value = flux[i]
    if (value < threshold) continue
    // 局部极大值才算一次起音，避免一个重音被拆成多个
    if (value < flux[i - 1]) continue
    if (i + 1 < buckets && value < flux[i + 1]) continue
    if (i - lastIndex < minGapBuckets) continue
    lastIndex = i
    const beat = roundBeat(clipSourceOriginBeat + (i * secondsPerBucket) / spb)
    // 只保留落在片段可见区间内的位置
    if (beat < clip.start - 1e-6 || beat > clip.start + clip.duration + 1e-6) continue
    if (beat < 0) continue
    out.push(beat)
  }
}

// ---------------------------------------------------------------- 虚拟键盘高亮

/** 屏幕键盘：按下发声（需要音频上下文已激活），力度取自键盘力度设置 */
export function previewAttack(trackId: string, midi: number, velocity = state.keyboardVelocity): void {
  engine.previewAttack(trackId, midi, velocity)
}

/** 屏幕键盘：抬起停止 */
export function previewRelease(trackId: string, midi: number): void {
  engine.previewRelease(trackId, midi)
}

/**
 * 写谱试听：新增音符 / 拖动改音高时立即响一下当前音色，
 * 帮助确认写下的音高与音色。采用一次性触发，无需手动抬起。
 */
export function previewNote(trackId: string, midi: number, velocity = 0.85): void {
  engine.previewNote(trackId, midi, velocity)
}

const pitchExpiry = new Map<number, number>()

function highlightPitch(midi: number): void {
  const holdMs = Math.max(140, (60 / state.project.bpm) * 1000 * 0.6)
  pitchExpiry.set(midi, performance.now() + holdMs)
  if (!state.activePitches.includes(midi)) state.activePitches.push(midi)
}

function pruneHighlights(): void {
  if (pitchExpiry.size === 0) return
  const now = performance.now()
  let changed = false
  for (const [midi, expiry] of Array.from(pitchExpiry.entries())) {
    if (expiry <= now) {
      pitchExpiry.delete(midi)
      changed = true
    }
  }
  if (changed) state.activePitches = state.activePitches.filter((m) => pitchExpiry.has(m))
}

// ---------------------------------------------------------------- 工程文件

export function newProject(): void {
  stop()
  state.project = createEmptyProject()
  seedDefaultTracks()
  state.selectedTrackId = state.project.tracks[0]?.id ?? ''
  state.selectedNoteIds = []
  state.selectedClipId = ''
  state.selectedMarkerId = ''
  state.view.scrollLeft = 0
  resetHistory(state.project)
  // 新建工程先不落盘：用户未做任何改动就退出时，不出现在历史列表里
  projectPersisted = false
  commit()
  applyProjectToEngine()
  syncNow()
}

export function saveProjectNow(): void {
  persistOnly()
  state.statusText = `已保存到本地：${state.project.name}`
}

export function loadProjectById(id: string): void {
  const loaded = storage.loadProject(id)
  if (!loaded) return
  const project = normalizeProject(loaded)
  stop()
  state.project = project
  state.selectedTrackId = project.tracks[0]?.id ?? ''
  state.selectedNoteIds = []
  state.selectedClipId = ''
  state.selectedMarkerId = ''
  state.view.scrollLeft = 0
  resetHistory(project)
  projectPersisted = true
  applyProjectToEngine()
  commit()
  syncNow()
  void hydrateAudio()
  state.statusText = `已加载：${project.name}`
}

export function deleteSavedProject(id: string): void {
  storage.deleteProject(id)
  state.savedProjects = storage.readMetas()
}

/** 重命名历史工程；若正好是当前打开的那个工程，同步改掉它的工程名 */
export function renameSavedProject(id: string, name: string): void {
  const next = name.trim()
  if (!next) return
  storage.renameProject(id, next)
  if (state.project.id === id && state.project.name !== next) {
    state.project.name = next
    persistOnly()
  }
  state.savedProjects = storage.readMetas()
  state.statusText = `已重命名为「${next}」`
}

/** 导出某个历史工程为 JSON（不影响当前正在编辑的工程） */
export function exportSavedProjectJson(id: string): void {
  const project = storage.loadProject(id)
  if (!project) {
    state.statusText = '未找到该工程'
    return
  }
  // 与「导出工程 JSON」同格式：存纯数据快照
  const snapshot = JSON.parse(JSON.stringify(project)) as Project
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
  downloadBlob(blob, `${project.name || 'project'}.json`)
  state.statusText = `已导出：${project.name}`
}

/** 导出工程 JSON */
export function exportProjectJson(): void {
  const snapshot = JSON.parse(JSON.stringify(state.project)) as Project
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
  downloadBlob(blob, `${state.project.name || 'project'}.json`)
  state.statusText = '已导出工程 JSON'
}

/** 导入工程 JSON */
export async function importProjectJson(file: File): Promise<void> {
  try {
    const text = await file.text()
    const parsed = JSON.parse(text) as Partial<Project>
    if (!parsed || !Array.isArray(parsed.tracks)) throw new Error('文件结构不正确')
    stop()
    const project = normalizeProject(parsed, file.name.replace(/\.json$/i, ''))
    state.project = project
    state.selectedTrackId = project.tracks[0]?.id ?? ''
    state.selectedNoteIds = []
    state.selectedClipId = ''
    state.view.scrollLeft = 0
    resetHistory(project)
    projectPersisted = true
    applyProjectToEngine()
    commit()
    syncNow()
    await hydrateAudio()
    state.statusText = `已导入：${project.name}`
  } catch (error) {
    state.statusText = `导入失败：${(error as Error).message}`
  }
}

// ---------------------------------------------------------------- MIDI 读写

/** 导出 MIDI 文件（音频轨无法写入 SMF，只导出 MIDI 轨） */
export function exportMidi(): void {
  try {
    const blob = projectToMidi(state.project)
    downloadBlob(blob, `${state.project.name || 'project'}.mid`)
    state.statusText = '已导出 MIDI 文件'
  } catch (error) {
    state.statusText = `导出 MIDI 失败：${(error as Error).message}`
  }
}

/**
 * 导入 MIDI 文件。
 * 采用「追加轨道」而不是替换工程，避免误操作丢失当前内容；
 * 仅当当前工程还没有任何音符时，才沿用文件里的速度与拍号。
 */
export async function importMidiFile(file: File): Promise<void> {
  try {
    const buffer = await file.arrayBuffer()
    const result = parseMidi(buffer)
    if (result.tracks.length === 0) {
      state.statusText = '该 MIDI 文件里没有可导入的音符'
      return
    }

    const existingNotes = state.project.tracks.reduce(
      (sum, t) => sum + t.regions.reduce((s, r) => s + r.notes.length, 0),
      0
    )
    if (existingNotes === 0) {
      state.project.bpm = clamp(result.bpm, 40, 200)
      state.project.timeSignature = result.timeSignature
      engine.setBpm(state.project.bpm)
      engine.setTimeSignature(state.project.timeSignature)
    }

    let maxEnd = 0
    for (const imported of result.tracks) {
      const track = createTrack(state.project, imported.instrument, state.project.tracks.length)
      track.name = imported.name
      const region = track.regions[0]
      if (region) {
        region.name = imported.name
        region.notes = imported.notes
        imported.notes.forEach((n) => {
          maxEnd = Math.max(maxEnd, n.start + n.duration)
        })
      }
      state.project.tracks.push(track)
    }
    ensureBarsForBeat(maxEnd)
    state.selectedTrackId = state.project.tracks[state.project.tracks.length - result.tracks.length]?.id ?? ''
    state.selectedNoteIds = []
    state.selectedClipId = ''
    record(`导入 MIDI：${result.tracks.length} 条轨道`)
    commit()
    syncNow()
    state.statusText = `已从 MIDI 导入 ${result.tracks.length} 条轨道`
  } catch (error) {
    state.statusText = `导入 MIDI 失败：${(error as Error).message}`
  }
}

/** WAV 导出选项（导出对话框使用） */
export interface ExportWavOptions {
  /** 起始小节（0 基），缺省从第 1 小节开始 */
  fromBar?: number
  /** 结束小节（不含），缺省到工程末尾 */
  toBar?: number
  /** 位深：16 或 24，默认 16 */
  bitDepth?: 16 | 24
  /** 采样率（Hz），缺省跟随浏览器音频上下文 */
  sampleRate?: number
  /** 分轨导出：每条可发声轨道单独一个 wav 文件 */
  stems?: boolean
}

/** 清理文件名里不允许出现的字符 */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
}

/**
 * 生成分轨导出用的工程副本：除目标轨及其编组祖先链外全部静音。
 * 编组轨是子轨的信号通路，不能静音，否则子轨会跟着没声；
 * 目标轨自身的静音状态被忽略，保证导出的分轨总有内容。
 */
function cloneProjectForStem(project: Project, keepTrackId: string): Project {
  const inAncestorChain = (id: string): boolean => {
    let cur = project.tracks.find((t) => t.id === keepTrackId)
    while (cur) {
      if (cur.id === id) return true
      // 先取局部变量再查找，避免闭包捕获可空引用导致 TS 误报
      const parentId = cur.parentId
      cur = parentId ? project.tracks.find((t) => t.id === parentId) : undefined
    }
    return false
  }
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === keepTrackId || inAncestorChain(t.id)
        ? { ...t, mute: false, solo: false }
        : { ...t, mute: true, solo: false }
    )
  }
}

/** 渲染并导出 WAV（支持区间 / 位深 / 采样率 / 分轨） */
export async function exportAudioWav(opts: ExportWavOptions = {}): Promise<void> {
  if (state.busy) return
  await ensureAudio()
  state.busy = true
  try {
    const beatsPerBar = beatsPerBarOf(state.project.timeSignature)
    const totalBeats = state.project.bars * beatsPerBar
    const fromBeat = Math.max(0, (opts.fromBar ?? 0) * beatsPerBar)
    // 结束小节收敛到工程范围内，且至少保留四分之一小节
    const toBeat = clamp((opts.toBar ?? state.project.bars) * beatsPerBar, fromBeat + beatsPerBar / 4, totalBeats)
    const renderOpts = { fromBeat, toBeat, sampleRate: opts.sampleRate }
    const bitDepth = opts.bitDepth ?? 16
    const baseName = sanitizeFileName(state.project.name || 'project')

    state.statusText = '正在离线渲染音频…'
    if (opts.stems) {
      const targets = state.project.tracks.filter((t) => t.kind !== 'group')
      if (targets.length === 0) throw new Error('工程里没有可导出的轨道')
      let index = 0
      for (const track of targets) {
        index += 1
        state.statusText = `正在导出分轨（${index}/${targets.length}）：${track.name}…`
        const stem = await engine.renderToAudioBuffer(cloneProjectForStem(state.project, track.id), renderOpts)
        downloadBlob(audioBufferToWavBlob(stem, bitDepth), `${baseName} - ${sanitizeFileName(track.name)}.wav`)
      }
      state.statusText = `分轨导出完成（${targets.length} 个文件）`
    } else {
      const buffer = await engine.renderToAudioBuffer(state.project, renderOpts)
      downloadBlob(audioBufferToWavBlob(buffer, bitDepth), `${baseName}.wav`)
      state.statusText = 'WAV 导出完成'
    }
  } catch (error) {
    console.error('[exportAudioWav]', error)
    state.statusText = `WAV 导出失败：${(error as Error).message}`
  } finally {
    state.busy = false
  }
}
