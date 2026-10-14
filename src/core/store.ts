import { reactive } from 'vue'
import type {
  AudioClip,
  CustomInstrument,
  CustomInstrumentKind,
  CustomSample,
  EffectType,
  EqBand,
  GridDivision,
  InstrumentType,
  Note,
  Project,
  ProjectMeta,
  Region,
  DeviceMode,
  TimeSignature,
  Track,
  TrackEffect,
  TrackKind,
  ViewMode,
  VolumeDisplay
} from '@/types'
import {
  EFFECT_DEF_MAP,
  EQ_MAX,
  EQ_MIN,
  INSTRUMENT_LABELS,
  LIMITER_MAX,
  LIMITER_MIN,
  TIME_SIGNATURE_OPTIONS,
  TRACK_COLORS,
  VELOCITY_MAX,
  VELOCITY_MIN,
  defaultEffectParams,
  drumNoteLabel,
  resolveInstrumentLabel
} from '@/types'
import {
  MAX_MIDI,
  MIN_MIDI,
  beatsPerBarOf,
  clamp,
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
  /** 自定义音源管理对话框是否打开 */
  customSoundOpen: boolean
  /** Pad 端长按触发时间（ms）：超过该时长即视为长按，用于启动框选或弹出右键菜单 */
  longPressDuration: number
  /** Pad 端是否在底部常驻显示虚拟键盘（PC 端默认折叠） */
  touchKeyboardAlwaysOn: boolean
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
  const label = resolveInstrumentLabel(instrument, project.customInstruments, customInstrumentId)
  return {
    id: uid('trk'),
    name: isAudio ? `音频轨 ${index + 1}` : `${label} ${index + 1}`,
    kind,
    instrument,
    customInstrumentId: instrument === 'custom' ? customInstrumentId : '',
    ...(isAudio ? DEFAULT_AUDIO_MIX : DEFAULT_MIX),
    effects: [],
    mute: false,
    solo: false,
    color: isAudio ? '#8fa8ff' : TRACK_COLORS[index % TRACK_COLORS.length],
    // 音频轨不使用片段模型，音符容器留空
    regions: isAudio ? [] : [makeRegion(project)],
    clips: []
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
      params
    })
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
  const kind: TrackKind = raw.kind === 'audio' ? 'audio' : 'midi'
  const isAudio = kind === 'audio'
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
    clips: normalizeClips(raw.clips)
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
    createdAt: raw.createdAt ?? base.createdAt,
    updatedAt: raw.updatedAt ?? base.updatedAt
  }
}

// ---------------------------------------------------------------- 全局状态

export const state = reactive<AppState>({
  project: createEmptyProject(),
  selectedTrackId: '',
  selectedNoteIds: [],
  selectedClipId: '',
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
  velocityLaneOn: true,
  noteColorByVelocity: false,
  keyboardVelocity: 0.85,
  volumeDisplay: 'db',
  deviceMode: 'pc',
  settingsOpen: false,
  customSoundOpen: false,
  longPressDuration: 450,
  touchKeyboardAlwaysOn: true,
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
  } else {
    state.project = createEmptyProject()
    seedDefaultTracks()
  }
  state.selectedTrackId = state.project.tracks[0]?.id ?? ''
  state.savedProjects = storage.readMetas()

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

  const tick = () => {
    state.isPlaying = engine.isPlaying
    state.playheadBeats = engine.getBeats()
    if (state.isCountingIn && engine.getBeats() > 0) state.isCountingIn = false
    if (state.recording) state.recordingSeconds = recordingSeconds()

    // 仅在音频上下文就绪后才采样电平，避免未初始化时读到无意义的 0
    if (state.audioReady) sampleLevels()

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
}

/** 立即把当前工程同步到音频引擎并写入 localStorage */
function syncNow(): void {
  engine.syncTracks(state.project)
  engine.scheduleProject(state.project)
  engine.updateAllMix(state.project)
  engine.setLoop(state.loopOn)
  state.project.updatedAt = Date.now()
  storage.saveProject(state.project)
  state.savedProjects = storage.readMetas()
}

/** 仅做持久化（不需要重排音符的改动） */
function persistOnly(): void {
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
 * 选中音频轨时从钢琴卷帘切到波形视图，选中 MIDI 轨时从波形视图切回钢琴卷帘。
 * 混音台视图由用户显式选择，不做自动切换。
 */
function alignViewModeWithTrack(track: Track | undefined): void {
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
  record('调整音量', `vol:${id}`)
  persistOnly()
}

export function setTrackPan(id: string, pan: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.pan = clamp(pan, -1, 1)
  engine.updateMix(track, state.project.tracks)
  record('调整声像', `pan:${id}`)
  persistOnly()
}

/** 调整某个均衡频段（dB） */
export function setTrackEq(id: string, band: EqBand, value: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track[band] = clamp(value, EQ_MIN, EQ_MAX)
  engine.setTrackEq(id, band, track[band])
  record('调整均衡', `eq:${id}:${band}`)
  persistOnly()
}

/** 调整混响发送量（0~1） */
export function setTrackReverbSend(id: string, value: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.reverbSend = clamp(value, 0, 1)
  engine.setTrackReverbSend(id, track.reverbSend)
  record('调整混响发送', `send:${id}`)
  persistOnly()
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
  pushEffects(track)
  record('重置效果器参数')
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

/** 再制选中音符：整组紧跟选区末尾平移一份 */
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
  record(`再制 ${created.length} 个音符`)
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

/** 打开 / 关闭自定义音源管理对话框 */
export function openCustomSound(): void {
  state.customSoundOpen = true
}

export function closeCustomSound(): void {
  state.customSoundOpen = false
}

// ------------------------------------------------------------ 工程级设置

export function setBpm(bpm: number): void {
  state.project.bpm = clamp(Math.round(bpm), 40, 200)
  engine.setBpm(state.project.bpm)
  record('调整速度')
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
}

/** 切换「按力度着色」显示 */
export function toggleNoteColor(): void {
  state.noteColorByVelocity = !state.noteColorByVelocity
}

/** 设置虚拟键盘 / 试听力度（0~1） */
export function setKeyboardVelocity(velocity: number): void {
  state.keyboardVelocity = clamp(velocity, VELOCITY_MIN, VELOCITY_MAX)
}

/** 切换音量读数单位：dB ↔ 线性百分比（全局生效，仅影响显示） */
export function toggleVolumeDisplay(): void {
  state.volumeDisplay = state.volumeDisplay === 'db' ? 'linear' : 'db'
}

/** 切换设备模式（pc / pad），切换后整体布局与交互方式都会调整 */
export function setDeviceMode(mode: DeviceMode): void {
  state.deviceMode = mode
  // Pad 模式下自动加大行高，方便手指点击
  if (mode === 'pad' && state.view.rowHeight < 20) state.view.rowHeight = 22
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
}

/** 切换 Pad 端虚拟键盘是否常驻显示 */
export function toggleTouchKeyboardAlwaysOn(): void {
  state.touchKeyboardAlwaysOn = !state.touchKeyboardAlwaysOn
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
  engine.pause()
  state.isPlaying = false
  state.isCountingIn = false
}

export function stop(): void {
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
  state.view.scrollLeft = 0
  resetHistory(state.project)
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
  state.view.scrollLeft = 0
  resetHistory(project)
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

/** 渲染并导出 WAV */
export async function exportWav(): Promise<void> {
  if (state.busy) return
  await ensureAudio()
  state.busy = true
  state.statusText = '正在离线渲染音频…'
  try {
    const buffer = await engine.renderToAudioBuffer(state.project)
    downloadBlob(audioBufferToWavBlob(buffer), `${state.project.name || 'project'}.wav`)
    state.statusText = 'WAV 导出完成'
  } catch (error) {
    console.error('[exportWav]', error)
    state.statusText = `WAV 导出失败：${(error as Error).message}`
  } finally {
    state.busy = false
  }
}
