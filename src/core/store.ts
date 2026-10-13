import { reactive } from 'vue'
import type {
  EqBand,
  GridDivision,
  InstrumentType,
  Note,
  Project,
  ProjectMeta,
  Region,
  TimeSignature,
  Track,
  ViewMode
} from '@/types'
import { EQ_MAX, EQ_MIN, INSTRUMENT_LABELS, LIMITER_MAX, LIMITER_MIN, TRACK_COLORS } from '@/types'
import { beatsPerBarOf, clamp, roundBeat, snapTo, uid } from '@/utils/music'
import { audioBufferToWavBlob, downloadBlob } from '@/utils/wav'
import { getAudioEngine } from './audioEngine'
import * as storage from './persistence'

const engine = getAudioEngine()

/** 新轨道的默认混音参数 */
const DEFAULT_MIX = {
  volume: 0.8,
  pan: 0,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  reverbSend: 0.2
}

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
  isPlaying: boolean
  /** 预备拍进行中 */
  isCountingIn: boolean
  playheadBeats: number
  snapDivision: GridDivision
  metronomeOn: boolean
  countInOn: boolean
  loopOn: boolean
  /** 虚拟键盘高亮的音高 */
  activePitches: number[]
  /** 中央编辑区当前展示的视图 */
  viewMode: ViewMode
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

export function createTrack(project: Project, instrument: InstrumentType, index: number): Track {
  return {
    id: uid('trk'),
    name: `${INSTRUMENT_LABELS[instrument]} ${index + 1}`,
    instrument,
    ...DEFAULT_MIX,
    mute: false,
    solo: false,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    regions: [makeRegion(project)]
  }
}

/**
 * 补齐工程里可能缺失的字段（兼容旧版本 localStorage 数据与手工编辑过的 JSON）。
 * 音频引擎与 UI 都假设这些字段一定存在，因此在入口处统一做一次归一化。
 */
function normalizeTrack(raw: Partial<Track>, index: number): Track {
  return {
    id: raw.id ?? uid('trk'),
    name: raw.name ?? `轨道 ${index + 1}`,
    instrument: (raw.instrument ?? 'piano') as InstrumentType,
    volume: clamp(raw.volume ?? DEFAULT_MIX.volume, 0, 1),
    pan: clamp(raw.pan ?? DEFAULT_MIX.pan, -1, 1),
    eqLow: clamp(raw.eqLow ?? DEFAULT_MIX.eqLow, EQ_MIN, EQ_MAX),
    eqMid: clamp(raw.eqMid ?? DEFAULT_MIX.eqMid, EQ_MIN, EQ_MAX),
    eqHigh: clamp(raw.eqHigh ?? DEFAULT_MIX.eqHigh, EQ_MIN, EQ_MAX),
    reverbSend: clamp(raw.reverbSend ?? DEFAULT_MIX.reverbSend, 0, 1),
    mute: Boolean(raw.mute),
    solo: Boolean(raw.solo),
    color: raw.color ?? TRACK_COLORS[index % TRACK_COLORS.length],
    regions: (raw.regions ?? []).map((r) => ({
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
    }))
  }
}

export function normalizeProject(raw: Partial<Project>, fallbackName = '未命名工程'): Project {
  const base = createEmptyProject(raw.name ?? fallbackName)
  return {
    ...base,
    ...raw,
    bpm: clamp(raw.bpm ?? base.bpm, 40, 200),
    timeSignature: (raw.timeSignature ?? base.timeSignature) as TimeSignature,
    masterVolume: clamp(raw.masterVolume ?? base.masterVolume, 0, 1),
    reverbWet: clamp(raw.reverbWet ?? base.reverbWet, 0, 1),
    masterLimiter: clamp(raw.masterLimiter ?? base.masterLimiter, LIMITER_MIN, LIMITER_MAX),
    bars: raw.bars ?? base.bars,
    tracks: (raw.tracks ?? []).map((t, i) => normalizeTrack(t, i)),
    createdAt: raw.createdAt ?? base.createdAt,
    updatedAt: raw.updatedAt ?? base.updatedAt
  }
}

// ---------------------------------------------------------------- 全局状态

export const state = reactive<AppState>({
  project: createEmptyProject(),
  selectedTrackId: '',
  selectedNoteIds: [],
  isPlaying: false,
  isCountingIn: false,
  playheadBeats: 0,
  snapDivision: 0.25,
  metronomeOn: false,
  countInOn: true,
  loopOn: true,
  activePitches: [],
  viewMode: 'piano',
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

  startTickLoop()
  applyProjectToEngine()
  syncNow()
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
}

export function addTrack(instrument: InstrumentType = 'piano'): void {
  const track = createTrack(state.project, instrument, state.project.tracks.length)
  state.project.tracks.push(track)
  state.selectedTrackId = track.id
  state.selectedNoteIds = []
  commit()
}

export function removeTrack(id: string): void {
  const index = state.project.tracks.findIndex((t) => t.id === id)
  if (index < 0) return
  state.project.tracks.splice(index, 1)
  if (state.selectedTrackId === id) {
    state.selectedTrackId = state.project.tracks[Math.min(index, state.project.tracks.length - 1)]?.id ?? ''
    state.selectedNoteIds = []
  }
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
  commit()
}

export function renameTrack(id: string, name: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.name = name || track.name
  commit()
}

export function setTrackInstrument(id: string, instrument: InstrumentType): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track || track.instrument === instrument) return
  track.instrument = instrument
  commit()
}

// ---------------------------------------------------------------- 混音操作

export function setTrackVolume(id: string, volume: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.volume = clamp(volume, 0, 1)
  engine.updateMix(track, state.project.tracks)
  persistOnly()
}

export function setTrackPan(id: string, pan: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.pan = clamp(pan, -1, 1)
  engine.updateMix(track, state.project.tracks)
  persistOnly()
}

/** 调整某个均衡频段（dB） */
export function setTrackEq(id: string, band: EqBand, value: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track[band] = clamp(value, EQ_MIN, EQ_MAX)
  engine.setTrackEq(id, band, track[band])
  persistOnly()
}

/** 调整混响发送量（0~1） */
export function setTrackReverbSend(id: string, value: number): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.reverbSend = clamp(value, 0, 1)
  engine.setTrackReverbSend(id, track.reverbSend)
  persistOnly()
}

/** 把某条轨道的均衡与发送一键复位 */
export function resetTrackMix(id: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.volume = DEFAULT_MIX.volume
  track.pan = DEFAULT_MIX.pan
  track.eqLow = DEFAULT_MIX.eqLow
  track.eqMid = DEFAULT_MIX.eqMid
  track.eqHigh = DEFAULT_MIX.eqHigh
  track.reverbSend = DEFAULT_MIX.reverbSend
  engine.updateMix(track, state.project.tracks)
  persistOnly()
}

export function toggleMute(id: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.mute = !track.mute
  engine.updateAllMix(state.project)
  commit()
}

export function toggleSolo(id: string): void {
  const track = state.project.tracks.find((t) => t.id === id)
  if (!track) return
  track.solo = !track.solo
  engine.updateAllMix(state.project)
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

// ------------------------------------------------------------ 工程级设置

export function setBpm(bpm: number): void {
  state.project.bpm = clamp(Math.round(bpm), 40, 200)
  engine.setBpm(state.project.bpm)
  commit()
}

export function setTimeSignature(ts: TimeSignature): void {
  if (state.project.timeSignature === ts) return
  state.project.timeSignature = ts
  engine.setTimeSignature(ts)
  const total = state.project.bars * beatsPerBarOf(ts)
  state.project.tracks.forEach((t) => t.regions.forEach((r) => (r.length = total)))
  commit()
}

export function setMasterVolume(volume: number): void {
  state.project.masterVolume = clamp(volume, 0, 1)
  engine.setMasterVolume(state.project.masterVolume)
  persistOnly()
}

/** 混响返回量（共享混响总线送回主输出的电平） */
export function setReverbWet(wet: number): void {
  state.project.reverbWet = clamp(wet, 0, 1)
  engine.setReverbWet(state.project.reverbWet)
  persistOnly()
}

/** 总线限幅阈值（dB） */
export function setLimiterThreshold(db: number): void {
  state.project.masterLimiter = clamp(db, LIMITER_MIN, LIMITER_MAX)
  engine.setLimiterThreshold(state.project.masterLimiter)
  persistOnly()
}

export function setSnapDivision(division: GridDivision): void {
  state.snapDivision = division
}

/** 切换中央编辑区视图：钢琴卷帘 / 混音台 */
export function setViewMode(mode: ViewMode): void {
  state.viewMode = mode
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

/** 屏幕键盘：按下发声（需要音频上下文已激活） */
export function previewAttack(trackId: string, midi: number, velocity = 0.85): void {
  engine.previewAttack(trackId, midi, velocity)
}

/** 屏幕键盘：抬起停止 */
export function previewRelease(trackId: string, midi: number): void {
  engine.previewRelease(trackId, midi)
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
  state.view.scrollLeft = 0
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
  state.view.scrollLeft = 0
  applyProjectToEngine()
  commit()
  syncNow()
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
    state.view.scrollLeft = 0
    applyProjectToEngine()
    commit()
    syncNow()
    state.statusText = `已导入：${project.name}`
  } catch (error) {
    state.statusText = `导入失败：${(error as Error).message}`
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
