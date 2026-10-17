<script setup lang="ts">
/**
 * 钢琴卷帘（Canvas）
 * - 纵向：MIDI 音高 C0~C7；横向：小节网格
 * - 交互：点击新增、拖拽移动、拖两端改时长、右键/Delete 删除、框选、一键量化
 * - 只绘制视口内的行与音符，保证大量音符时依然流畅
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import DropdownMenu from './DropdownMenu.vue'
import type { AutomationPoint, GridDivision, Note } from '@/types'
import {
  AUTOMATION_PARAMS,
  AUTOMATION_PARAM_MAP,
  INSTRUMENT_LABELS,
  SCALE_DEFS,
  SCALE_ROOT_OPTIONS
} from '@/types'
import {
  activeRegion,
  activeTrack,
  addAutomationPoint,
  addNote,
  applyNoteVelocities,
  automationLane,
  automationStaticValue,
  clearAutomation,
  clearNoteSelection,
  commit,
  copySelectedNotes,
  cutSelectedNotes,
  deleteSelectedNotes,
  duplicateSelectedNotes,
  ensureBarsForBeat,
  humanizeTargetVelocity,
  moveAutomationPoint,
  nudgeTargetVelocity,
  pasteNotes,
  previewAttack,
  previewNote,
  previewRelease,
  quantizeSelected,
  quantizeSelectedToScale,
  removeAutomationPoint,
  removeNotes,
  scaleTargetVelocity,
  setAutomationParam,
  selectAllNotes,
  setNoteSelection,
  setScaleRoot,
  setScaleType,
  setTargetVelocity,
  snapMidi,
  state,
  toggleAutomationLane,
  toggleNoteColor,
  toggleNoteSelection,
  toggleScaleLock,
  toggleVelocityLane
} from '@/core/store'
import { MAX_MIDI, MIN_MIDI, beatsPerBarOf, clamp, floorToGrid, isBlackKey, midiToNoteName, roundBeat, snapTo } from '@/utils/music'
import { midiToVelocity, velocityToMidi } from '@/utils/audio'
import { hexToRgba } from '@/utils/color'
import {
  AUTOMATION_LANE_HEIGHT,
  KEY_WIDTH,
  NAV_HEIGHT,
  SCROLLBAR_SIZE,
  VELOCITY_LANE_HEIGHT
} from '@/utils/layout'

const bodyEl = ref<HTMLDivElement | null>(null)
const gridEl = ref<HTMLCanvasElement | null>(null)
const keysEl = ref<HTMLCanvasElement | null>(null)
const velocityEl = ref<HTMLCanvasElement | null>(null)
/** 底部自动化包络条的画布 */
const automationEl = ref<HTMLCanvasElement | null>(null)
/** 底部缩略导航条：容器与画布 */
const navHostEl = ref<HTMLDivElement | null>(null)
const navCanvasEl = ref<HTMLCanvasElement | null>(null)

// ---------------------------------------------------------------- 操作提示弹层（「?」图标）
const hintOpen = ref(false)
const hintHover = ref(false)
const hintWrapEl = ref<HTMLDivElement | null>(null)
const hintBtnEl = ref<HTMLButtonElement | null>(null)
const hintPopEl = ref<HTMLDivElement | null>(null)
/** 弹层在视口中的坐标（position: fixed） */
const hintPos = ref({ x: 0, y: 0 })

/** 「音阶」下拉的组件引用：用于在执行一次性操作后收起面板 */
const scaleMenuEl = ref<InstanceType<typeof DropdownMenu> | null>(null)

function toggleHint(): void {
  hintOpen.value = !hintOpen.value
}

/**
 * 计算提示弹层位置：默认右对齐按钮下方，
 * 并用视口边界兜底裁剪，避免窄视口下被卷帘面板裁掉。
 * 头部工具栏会换行，按钮不一定在最右侧，所以不能用纯 CSS 定位。
 */
function positionHint(): void {
  const btn = hintBtnEl.value
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const w = hintPopEl.value?.offsetWidth ?? 190
  const h = hintPopEl.value?.offsetHeight ?? 130
  let x = r.right - w
  let y = r.bottom + 4
  if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8
  if (x < 8) x = 8
  // 下方放不下则翻到按钮上方
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 4)
  hintPos.value = { x, y }
}

/** 力度编辑条高度 */
const LANE_H = VELOCITY_LANE_HEIGHT
/** 力度编辑条拖动时的实时读数（MIDI 力度 0~127），未拖动时为 null */
const laneReadout = ref<number | null>(null)
/** 力度编辑条是否有选中（用于高亮提示） */
const laneSelected = computed(() => state.selectedNoteIds.length > 0)

// ---------------------------------------------------------------- 长按 & 右键菜单
// Pad 端没有键盘和右键，因此需要「长按」这一统一手势：
//   · 长按空白处 → 进入框选模式（手指继续拖动选范围）
//   · 长按选中音符 → 弹出右键菜单
//   · 长按未选中音符 → 先选中再弹菜单
// PC 端保留 Shift+拖拽框选 与 右键菜单，长按同样可用（方便触屏笔记本）。

/** 长按时钟（ms），从 store 读取，Pad 模式下用户可调 */
const longPressMs = computed(() => state.longPressDuration)
/** 长按计时器 id，null 表示未在计时 */
let longPressTimer: number | null = null
/** 长按是否已经触发（触发后后续 move/up 走框选或菜单逻辑） */
let longPressTriggered = false
/** 长按起始时的指针坐标（画布本地坐标），用于判断是否移动过多 */
let longPressOrigin = { x: 0, y: 0 }
/** 长按起始时是否点中了音符（决定长按后是弹菜单还是进框选） */
let longPressHitNote: Note | null = null
/** 长按开始时已选中的音符 id 集合快照（用于恢复多选状态） */
let longPressPrevSelection: string[] = []

/**
 * 判定「手指已移动」的容差（px）：
 * 触屏抖动明显，容差过小会让长按判定被抖动取消，导致长按手势时有时无。
 */
const MOVE_TOLERANCE_MOUSE = 6
const MOVE_TOLERANCE_TOUCH = 12
/** 本次手势的容差，在 pointerdown 时按 pointerType 决定 */
let moveTolerance = MOVE_TOLERANCE_MOUSE
/** 当前手势的主指针 id：多指同时触摸时忽略其它手指，避免第二根手指打断或串改拖拽状态 */
let activePointerId: number | null = null

/** 右键 / 长按菜单 */
const menuEl = ref<HTMLDivElement | null>(null)
const menuVisible = ref(false)
/** 菜单在视口中的坐标（clientX/clientY） */
const menuPos = ref({ x: 0, y: 0 })
/** 菜单弹出时，点击位置是否在某个音符上（决定菜单启用哪些项） */
const menuHitNote = ref<Note | null>(null)

function clearLongPressTimer(): void {
  if (longPressTimer !== null) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

/** 启动长按计时器，超时后根据命中情况触发框选或弹出菜单 */
function startLongPressTimer(x: number, y: number, hit: Note | null): void {
  clearLongPressTimer()
  longPressTriggered = false
  longPressOrigin = { x, y }
  longPressHitNote = hit
  longPressPrevSelection = [...state.selectedNoteIds]
  longPressTimer = window.setTimeout(() => {
    longPressTriggered = true
    longPressTimer = null
    if (longPressHitNote) {
      // 长按音符 → 弹出右键菜单
      // 如果这个音符未被选中，先选中它（不清除其它选中项，方便多选操作）
      const id = longPressHitNote.id
      if (!state.selectedNoteIds.includes(id)) {
        setNoteSelection([id])
      }
      openMenu(longPressOrigin.x, longPressOrigin.y, longPressHitNote)
    } else {
      // 长按空白 → 进入框选模式
      // 触屏上浏览器可能在长按期间先抛出原生 contextmenu（走 onContextMenu 弹了菜单），
      // 这里统一收起菜单，避免「一边框选一边挂着菜单」的冲突画面
      closeMenu()
      drag.mode = 'marquee'
      drag.marquee = { x0: longPressOrigin.x, y0: longPressOrigin.y, x1: longPressOrigin.x, y1: longPressOrigin.y }
      clearNoteSelection()
      requestDraw()
    }
  }, longPressMs.value)
}

/**
 * 在指定位置打开右键 / 长按菜单。
 * 传入的 localX/localY 是「画布本地坐标」（= 内容坐标，已含横向滚动量），
 * 因此必须以画布的 rect 为原点换算成视口坐标；
 * 若用 .pr-body 的 rect 作原点，横向滚动后菜单会整体偏移 scrollLeft。
 */
function openMenu(localX: number, localY: number, hitNote: Note | null): void {
  const canvas = gridEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  menuPos.value = {
    x: rect.left + localX,
    y: rect.top + localY
  }
  menuHitNote.value = hitNote
  menuVisible.value = true
  // 下一帧测量菜单尺寸，避免溢出视口
  nextTick(() => clampMenuPosition())
}

function clampMenuPosition(): void {
  const el = menuEl.value
  if (!el) return
  const w = el.offsetWidth
  const h = el.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  let { x, y } = menuPos.value
  if (x + w > vw - 8) x = vw - w - 8
  if (y + h > vh - 8) y = vh - h - 8
  if (x < 8) x = 8
  if (y < 8) y = 8
  menuPos.value = { x, y }
}

function closeMenu(): void {
  menuVisible.value = false
  menuHitNote.value = null
}

// -------- 菜单操作 --------

function menuCopy(): void {
  copySelectedNotes()
  closeMenu()
}

function menuCut(): void {
  cutSelectedNotes()
  closeMenu()
}

function menuPaste(): void {
  pasteNotes()
  closeMenu()
}

function menuDuplicate(): void {
  duplicateSelectedNotes()
  closeMenu()
}

function menuDelete(): void {
  deleteSelectedNotes()
  closeMenu()
}

function menuQuantize(): void {
  quantizeSelected()
  closeMenu()
  requestDraw()
}

function menuSelectAll(): void {
  selectAllNotes()
  closeMenu()
}

function menuVelUp(): void {
  nudgeTargetVelocity(0.047)
  closeMenu()
  requestDraw()
}

function menuVelDown(): void {
  nudgeTargetVelocity(-0.047)
  closeMenu()
  requestDraw()
}

function menuVelHumanize(): void {
  humanizeTargetVelocity(0.1)
  closeMenu()
  requestDraw()
}

/** 点击菜单 / 提示弹层以外的区域时关闭 */
function onMenuOutsidePointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (menuEl.value && !menuEl.value.contains(target)) closeMenu()
  if (hintWrapEl.value && !hintWrapEl.value.contains(target)) hintOpen.value = false
}

/** 视口顶部对应的 MIDI 音号（数值越大音越高，画布 y 越小） */
const topMidi = ref(84)

const rowHeight = computed(() => state.view.rowHeight)
const track = computed(() => activeTrack())
const region = computed(() => activeRegion())
const trackColor = computed(() => track.value?.color ?? '#4f9df7')

/**
 * 当前轨道是否按鼓组音区展示：
 * 内置鼓组直接判定，自定义音源按其 kind（drum / melodic）判定，
 * 鼓组音号集中在低音区，切换轨道时需要自动把音高窗口下调。
 */
const drumLike = computed(() => {
  const current = track.value
  if (!current) return false
  if (current.instrument === 'drums' || current.instrument === 'electroDrums') return true
  if (current.instrument === 'custom') {
    const custom = state.project.customInstruments.find((c) => c.id === current.customInstrumentId)
    return custom?.kind === 'drum'
  }
  return false
})

const totalBeats = computed(() => state.project.bars * beatsPerBarOf(state.project.timeSignature))
const totalWidth = computed(() => Math.max(200, totalBeats.value * state.view.pxPerBeat))
const noteCount = computed(() => region.value?.notes.length ?? 0)

type DragMode =
  | 'none'
  | 'create'
  | 'create-pending'
  | 'move'
  | 'move-pending'
  | 'resize-end'
  | 'resize-start'
  | 'marquee'
  /** 空白处按下、等待手势定性的中间态：拖动 → 框选，原地抬起 → 新增音符 */
  | 'marquee-pending'

interface NoteSnapshot {
  id: string
  start: number
  duration: number
  midi: number
}

/** 拖拽状态（普通对象即可，重绘由 rAF 驱动，不需要响应式） */
const drag: {
  mode: DragMode
  snapshots: NoteSnapshot[]
  originBeat: number
  originMidi: number
  moved: boolean
  marquee: { x0: number; y0: number; x1: number; y1: number } | null
  /** move/resize pending 时的目标模式（长按计时结束前暂存） */
  pendingTarget: DragMode
} = {
  mode: 'none',
  snapshots: [],
  originBeat: 0,
  originMidi: 0,
  moved: false,
  marquee: null,
  pendingTarget: 'move'
}

/**
 * 上一次写谱试听的音高。
 * 拖动音符改音高时，只有音高真正变化才再次发声，避免连续拖拽时声音糊成一片。
 */
let lastPreviewMidi: number | null = null

/**
 * 写谱试听：写下音符或把音符拖到新音高时，立即响一下当前轨道的音色，
 * 帮助确认写的是什么音。属于「一次性」试听，不需要手动抬起。
 */
function previewWritten(midi: number, velocity: number): void {
  const trackId = state.selectedTrackId
  if (!trackId) return
  previewNote(trackId, midi, velocity)
}

// ---------------------------------------------------------------- 绘制工具

/**
 * 力度着色：低力度偏冷（蓝），高力度偏暖（红），
 * 让「按力度着色」模式下一眼能看出强弱分布。
 */
function velocityColor(velocity: number): string {
  const v = clamp(velocity, 0, 1)
  const hue = 205 - 205 * v
  const light = 46 + v * 14
  return `hsl(${hue.toFixed(0)}, 78%, ${light.toFixed(0)}%)`
}

function prepareCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.round(cssWidth * dpr))
  const h = Math.max(1, Math.round(cssHeight * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return ctx
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const w = Math.max(2, width)
  const h = Math.max(2, height)
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}

function visibleRowCount(): number {
  const canvas = gridEl.value
  if (!canvas) return 24
  return Math.ceil(canvas.clientHeight / rowHeight.value) + 1
}

// ---------------------------------------------------------------- 绘制主网格

function drawGrid(): void {
  const canvas = gridEl.value
  const body = bodyEl.value
  if (!canvas || !body) return

  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  const ctx = prepareCanvas(canvas, cssWidth, cssHeight)
  if (!ctx) return
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const px = state.view.pxPerBeat
  const rowH = rowHeight.value
  const bpb = beatsPerBarOf(state.project.timeSignature)
  const step = state.snapDivision
  const top = topMidi.value
  const rows = visibleRowCount()

  // 视口范围（Canvas 坐标 = 拍 * px，滚动由外层容器负责）
  const viewL = body.scrollLeft
  const viewR = viewL + body.clientWidth
  const beatL = viewL / px
  const beatR = viewR / px

  // 1. 音高行底色（黑白键区分）
  for (let i = 0; i < rows; i += 1) {
    const midi = top - i
    if (midi < MIN_MIDI) break
    const y = i * rowH
    ctx.fillStyle = isBlackKey(midi) ? '#191a1f' : '#24262d'
    ctx.fillRect(viewL, y, viewR - viewL, rowH)
    ctx.fillStyle = midi % 12 === 0 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.045)'
    ctx.fillRect(viewL, y + rowH - 1, viewR - viewL, 1)
  }

  // 2. 纵向网格线（小节 / 拍 / 细分）
  const perBeat = Math.round(1 / step)
  const perBar = Math.round(bpb / step)
  const startIndex = Math.max(0, Math.floor(beatL / step))
  const endIndex = Math.ceil(beatR / step)
  for (let i = startIndex; i <= endIndex; i += 1) {
    const x = Math.floor(i * step * px)
    const isBar = i % perBar === 0
    const isBeat = i % perBeat === 0
    ctx.fillStyle = isBar
      ? 'rgba(255,255,255,0.26)'
      : isBeat
        ? 'rgba(255,255,255,0.12)'
        : 'rgba(255,255,255,0.05)'
    ctx.fillRect(x, 0, 1, cssHeight)
  }

  // 3. 音符（只遍历视口内的）
  const active = region.value
  if (active) {
    const selected = new Set(state.selectedNoteIds)
    const color = trackColor.value
    for (const note of active.notes) {
      if (note.start > beatR || note.start + note.duration < beatL) continue
      const rowIndex = top - note.midi
      if (rowIndex < -1 || rowIndex > rows) continue

      const x = note.start * px
      const y = rowIndex * rowH
      const w = Math.max(3, note.duration * px - 1)
      const h = Math.max(4, rowH - 2)
      const isSelected = selected.has(note.id)

      // 力度映射透明度，形成简单的力度可视化；开启「按力度着色」时改用冷→暖渐变
      ctx.globalAlpha = 0.45 + note.velocity * 0.55
      ctx.fillStyle = state.noteColorByVelocity ? velocityColor(note.velocity) : color
      roundRectPath(ctx, x, y + 1, w, h, 3)
      ctx.fill()
      ctx.globalAlpha = 1

      ctx.lineWidth = isSelected ? 2 : 1
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0,0,0,0.45)'
      roundRectPath(ctx, x + 0.5, y + 1.5, w - 1, h - 1, 3)
      ctx.stroke()
    }
  }

  // 4. 片段边界（Region 起点/终点）
  if (active) {
    const startX = Math.floor(active.start * px)
    const endX = Math.floor((active.start + active.length) * px)
    ctx.fillStyle = hexToRgba(trackColor.value, 0.5)
    if (startX >= viewL && startX <= viewR) ctx.fillRect(startX, 0, 1, cssHeight)
    if (endX >= viewL && endX <= viewR) ctx.fillRect(endX, 0, 1, cssHeight)
  }

  // 5. 播放头
  const playX = state.playheadBeats * px
  if (playX >= viewL - 6 && playX <= viewR + 6) {
    ctx.fillStyle = '#ff4d6d'
    ctx.fillRect(Math.floor(playX), 0, 2, cssHeight)
  }

  // 6. 框选矩形
  if (drag.mode === 'marquee' && drag.marquee) {
    const x = Math.min(drag.marquee.x0, drag.marquee.x1)
    const y = Math.min(drag.marquee.y0, drag.marquee.y1)
    const w = Math.abs(drag.marquee.x1 - drag.marquee.x0)
    const h = Math.abs(drag.marquee.y1 - drag.marquee.y0)
    ctx.fillStyle = 'rgba(79,157,247,0.16)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = 'rgba(79,157,247,0.9)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, y + 0.5, w, h)
  }
}

// ---------------------------------------------------------------- 绘制琴键列

function drawKeys(): void {
  const canvas = keysEl.value
  if (!canvas) return
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  const ctx = prepareCanvas(canvas, cssWidth, cssHeight)
  if (!ctx) return
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const rowH = rowHeight.value
  const top = topMidi.value
  const rows = Math.ceil(cssHeight / rowH) + 1
  ctx.textBaseline = 'middle'

  for (let i = 0; i < rows; i += 1) {
    const midi = top - i
    if (midi < MIN_MIDI) break
    const y = i * rowH
    const black = isBlackKey(midi)
    const active = state.activePitches.includes(midi)

    if (black) {
      ctx.fillStyle = '#141519'
      ctx.fillRect(0, y, cssWidth, rowH)
      ctx.fillStyle = active ? '#ff4d6d' : '#2b2d35'
      ctx.fillRect(0, y + 0.5, cssWidth * 0.62, rowH - 1)
    } else {
      ctx.fillStyle = active ? '#ffc2ce' : '#d6d9e1'
      ctx.fillRect(0, y + 0.5, cssWidth, rowH - 1)
      ctx.fillStyle = 'rgba(0,0,0,0.13)'
      ctx.fillRect(0, y + rowH - 1, cssWidth, 1)
    }

    // 音名标注：C 行加粗，其余白键淡显
    const pitchClass = ((midi % 12) + 12) % 12
    if (pitchClass === 0) {
      ctx.font = 'bold 9px "HarmonyOS Sans SC", system-ui, sans-serif'
      ctx.fillStyle = black ? '#eef1f6' : '#3d4252'
      ctx.fillText(midiToNoteName(midi), 4, y + rowH / 2)
      ctx.font = '9px "HarmonyOS Sans SC", system-ui, sans-serif'
    } else if (!black) {
      ctx.fillStyle = 'rgba(0,0,0,0.34)'
      ctx.fillText(midiToNoteName(midi), 4, y + rowH / 2)
    }
  }
}

// ---------------------------------------------------------------- 力度编辑条

/** 力度条上一根柱子（对应一个音符）的宽度 */
function laneBarWidth(note: Note): number {
  const px = state.view.pxPerBeat
  return clamp(note.duration * px - 1, 3, 18)
}

/** 绘制力度编辑条：每个音符一根柱子，柱高代表力度 */
function drawVelocity(): void {
  const canvas = velocityEl.value
  if (!canvas) return
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  const ctx = prepareCanvas(canvas, cssWidth, cssHeight)
  if (!ctx) return
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // 背景 + 参考线（1/2、1/4 力度）
  ctx.fillStyle = '#14151a'
  ctx.fillRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.fillRect(0, Math.round(cssHeight * 0.5), cssWidth, 1)
  ctx.fillRect(0, Math.round(cssHeight * 0.25), cssWidth, 1)
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  ctx.fillRect(0, 0, cssWidth, 1)

  const active = region.value
  if (!active) return
  const px = state.view.pxPerBeat
  const body = bodyEl.value
  // 只绘制视口内的柱子（画布已随滚动做了位移，这里用滚动范围做裁剪）
  const viewL = body?.scrollLeft ?? 0
  const viewR = viewL + cssWidth
  const selected = new Set(state.selectedNoteIds)
  const color = trackColor.value

  for (const note of active.notes) {
    const x = note.start * px
    if (x > viewR || x + 40 < viewL) continue
    const barW = laneBarWidth(note)
    const barH = Math.max(2, note.velocity * (cssHeight - 6))
    const isSelected = selected.has(note.id)
    ctx.globalAlpha = isSelected ? 1 : 0.8
    ctx.fillStyle = isSelected ? '#ffffff' : state.noteColorByVelocity ? velocityColor(note.velocity) : color
    roundRectPath(ctx, x, cssHeight - barH - 2, barW, barH, 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // 拖动力度条时画一条贯穿视口的水平参考线：
  // 线高与被抓取柱子的顶面对齐，方便和其它柱子比高度
  if (laneDrag.active) {
    const lineY = Math.round(cssHeight - 2 - laneDrag.value * (cssHeight - 6))
    ctx.fillStyle = 'rgba(79, 157, 247, 0.28)'
    ctx.fillRect(0, lineY - 1, cssWidth, 3)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.fillRect(0, lineY, cssWidth, 1)
  }
}

// ---------------------------------------------------------------- 横向缩略导航条

/**
 * 绘制底部缩略导航条：
 * 把整首歌（totalWidth）压缩进容器宽度，缩略画出所有音符，
 * 再叠一层半透明的「视口窗口」表示当前可见的横向范围。
 * 导航条自身不滚动，因此每次整条重绘。
 */
function drawNav(): void {
  const canvas = navCanvasEl.value
  const host = navHostEl.value
  const body = bodyEl.value
  if (!canvas || !host || !body) return

  const cssWidth = host.clientWidth
  const cssHeight = host.clientHeight
  const ctx = prepareCanvas(canvas, cssWidth, cssHeight)
  if (!ctx) return
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  ctx.fillStyle = '#111217'
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  const total = totalWidth.value
  if (total <= 0) return
  /** 网格像素 → 导航像素 的缩放系数 */
  const scale = cssWidth / total

  // 小节分隔线，帮助快速定位
  const bpb = beatsPerBarOf(state.project.timeSignature)
  const px = state.view.pxPerBeat
  for (let bar = 0; bar <= state.project.bars; bar += 1) {
    const x = Math.round(bar * bpb * px * scale)
    ctx.fillStyle = 'rgba(255,255,255,0.10)'
    ctx.fillRect(x, 0, 1, cssHeight)
  }

  // 音符缩略：纵向把 MIN_MIDI~MAX_MIDI 压缩进导航条高度
  const active = region.value
  const pad = 2
  const innerH = Math.max(1, cssHeight - pad * 2)
  const midiSpan = MAX_MIDI - MIN_MIDI + 1
  if (active && active.notes.length > 0) {
    const color = trackColor.value
    const noteH = Math.max(1.5, (innerH / midiSpan) * 2)
    for (const note of active.notes) {
      const x = note.start * px * scale
      const w = Math.max(1.5, note.duration * px * scale)
      const y = pad + ((MAX_MIDI - note.midi) / midiSpan) * innerH
      ctx.globalAlpha = 0.4 + note.velocity * 0.5
      ctx.fillStyle = color
      ctx.fillRect(x, y, w, noteH)
    }
    ctx.globalAlpha = 1
  }

  // 视口窗口：当前网格可见的横向范围
  const winX = body.scrollLeft * scale
  const winW = Math.max(8, body.clientWidth * scale)
  ctx.fillStyle = 'rgba(79,157,247,0.16)'
  ctx.fillRect(winX, 0, winW, cssHeight)
  ctx.strokeStyle = 'rgba(79,157,247,0.9)'
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(winX) + 0.5, 0.5, Math.max(8, Math.round(winW)) - 1, cssHeight - 1)
}

/** 导航条本地 x（相对画布左边缘） */
function navLocalX(event: PointerEvent): number {
  const host = navHostEl.value
  if (!host) return 0
  return event.clientX - host.getBoundingClientRect().left
}

/** 导航条拖拽状态：抓取点相对视口窗口左边缘的偏移 */
const navDrag = { active: false, grabOffset: 0 }

/** 把导航条位置换算成网格滚动位置（navX 为视口窗口左边缘在导航条上的 x） */
function applyNavScroll(navX: number): void {
  const body = bodyEl.value
  const host = navHostEl.value
  if (!body || !host) return
  const total = totalWidth.value
  if (total <= 0) return
  const scale = host.clientWidth / total
  const max = Math.max(0, body.scrollWidth - body.clientWidth)
  body.scrollLeft = clamp(navX / scale, 0, max)
  state.view.scrollLeft = body.scrollLeft
  requestDraw()
}

function onNavPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const body = bodyEl.value
  const host = navHostEl.value
  if (!body || !host) return
  const total = totalWidth.value
  if (total <= 0) return

  const scale = host.clientWidth / total
  const x = navLocalX(event)
  const winX = body.scrollLeft * scale
  const winW = Math.max(8, body.clientWidth * scale)

  if (x >= winX && x <= winX + winW) {
    // 点在视口窗口内：保留抓取偏移，直接拖拽
    navDrag.grabOffset = x - winX
  } else {
    // 点在窗口外：把视口中心移到点击处
    navDrag.grabOffset = winW / 2
    applyNavScroll(x - navDrag.grabOffset)
  }
  navDrag.active = true
  window.addEventListener('pointermove', onNavPointerMove)
  window.addEventListener('pointerup', onNavPointerUp)
  window.addEventListener('pointercancel', onNavPointerUp)
}

function onNavPointerMove(event: PointerEvent): void {
  if (!navDrag.active) return
  applyNavScroll(navLocalX(event) - navDrag.grabOffset)
}

function onNavPointerUp(): void {
  if (!navDrag.active) return
  navDrag.active = false
  window.removeEventListener('pointermove', onNavPointerMove)
  window.removeEventListener('pointerup', onNavPointerUp)
  window.removeEventListener('pointercancel', onNavPointerUp)
}

// ---------------------------------------------------------------- 自绘滚动条

/**
 * 网格视口尺寸（随面板缩放 / 布局调整同步）。
 * 滑块的占比和行程都依赖它，因此需要一份响应式副本：
 * 直接从 DOM 现读无法驱动模板重新渲染。
 */
const viewportW = ref(0)
const viewportH = ref(0)
const vbarEl = ref<HTMLElement | null>(null)
const hbarEl = ref<HTMLElement | null>(null)

/** 滑块最小长度，避免缩放到最小时滑块细到抓不住 */
const THUMB_MIN = 24

function syncViewportSize(): void {
  const body = bodyEl.value
  if (!body) return
  viewportW.value = body.clientWidth
  viewportH.value = body.clientHeight
}

/** 与 visibleRowCount 同一套换算，但作用于给定高度（视口尺寸同步前也能算） */
function visibleRowsAt(height: number): number {
  return Math.min(MAX_MIDI - MIN_MIDI + 1, Math.ceil(height / rowHeight.value) + 1)
}

/** 竖向滑块：高度 = 可视行数占总行数的比例，位置由 topMidi 反算 */
const vThumb = computed(() => {
  const track = viewportH.value
  const rows = MAX_MIDI - MIN_MIDI + 1
  if (track <= 0) return { height: 0, top: 0 }
  const visible = visibleRowsAt(track)
  const height = Math.max(THUMB_MIN, (visible / rows) * track)
  const minTop = MIN_MIDI + visible - 1
  const span = Math.max(1, MAX_MIDI - minTop)
  return { height, top: ((MAX_MIDI - topMidi.value) / span) * (track - height) }
})

/** 横向滑块：宽度 = 视口占内容宽度的比例，位置由 scrollLeft 反算 */
const hThumb = computed(() => {
  const track = viewportW.value
  const content = Math.max(track, totalWidth.value)
  if (track <= 0 || content <= track) return { width: 0, left: 0 }
  const width = Math.max(THUMB_MIN, (track / content) * track)
  const maxScroll = content - track
  return { width, left: clamp(state.view.scrollLeft / maxScroll, 0, 1) * (track - width) }
})

// ---- 竖向滚动条

const vDrag = { active: false, offset: 0 }

function onVScrollPointerDown(event: PointerEvent): void {
  const host = vbarEl.value
  const { top, height } = vThumb.value
  if (!host || event.button !== 0 || height <= 0 || height >= viewportH.value) return
  const y = event.clientY - host.getBoundingClientRect().top
  const onThumb = y >= top && y <= top + height
  // 点在轨道上 → 让点击处成为滑块中心；点在滑块上 → 保留抓取偏移
  vDrag.offset = onThumb ? y - top : height / 2
  if (!onThumb) applyVScroll(y - vDrag.offset)
  vDrag.active = true
  window.addEventListener('pointermove', onVScrollPointerMove)
  window.addEventListener('pointerup', onVScrollPointerUp)
  window.addEventListener('pointercancel', onVScrollPointerUp)
}

function onVScrollPointerMove(event: PointerEvent): void {
  const host = vbarEl.value
  if (!vDrag.active || !host) return
  applyVScroll(event.clientY - host.getBoundingClientRect().top - vDrag.offset)
}

function onVScrollPointerUp(): void {
  if (!vDrag.active) return
  vDrag.active = false
  window.removeEventListener('pointermove', onVScrollPointerMove)
  window.removeEventListener('pointerup', onVScrollPointerUp)
  window.removeEventListener('pointercancel', onVScrollPointerUp)
}

/** 拖动竖向滑块：滑块顶部位置 → 新的音高窗口（夹取范围与滚轮保持一致） */
function applyVScroll(thumbTop: number): void {
  const track = viewportH.value
  const travel = track - vThumb.value.height
  if (travel <= 0) return
  const visible = visibleRowsAt(track)
  const minTop = MIN_MIDI + visible - 1
  const span = Math.max(1, MAX_MIDI - minTop)
  topMidi.value = clamp(Math.round(MAX_MIDI - clamp(thumbTop / travel, 0, 1) * span), minTop, MAX_MIDI)
  requestDraw()
}

// ---- 横向滚动条

const hDrag = { active: false, offset: 0 }

function onHScrollPointerDown(event: PointerEvent): void {
  const host = hbarEl.value
  const { left, width } = hThumb.value
  if (!host || event.button !== 0 || width <= 0 || width >= viewportW.value) return
  const x = event.clientX - host.getBoundingClientRect().left
  const onThumb = x >= left && x <= left + width
  hDrag.offset = onThumb ? x - left : width / 2
  if (!onThumb) applyHScroll(x - hDrag.offset)
  hDrag.active = true
  window.addEventListener('pointermove', onHScrollPointerMove)
  window.addEventListener('pointerup', onHScrollPointerUp)
  window.addEventListener('pointercancel', onHScrollPointerUp)
}

function onHScrollPointerMove(event: PointerEvent): void {
  const host = hbarEl.value
  if (!hDrag.active || !host) return
  applyHScroll(event.clientX - host.getBoundingClientRect().left - hDrag.offset)
}

function onHScrollPointerUp(): void {
  if (!hDrag.active) return
  hDrag.active = false
  window.removeEventListener('pointermove', onHScrollPointerMove)
  window.removeEventListener('pointerup', onHScrollPointerUp)
  window.removeEventListener('pointercancel', onHScrollPointerUp)
}

/** 拖动横向滑块：滑块左端位置 → 网格滚动位置（onScroll 会把它同步进 state） */
function applyHScroll(thumbLeft: number): void {
  const body = bodyEl.value
  const travel = viewportW.value - hThumb.value.width
  if (!body || travel <= 0) return
  const maxScroll = Math.max(0, body.scrollWidth - body.clientWidth)
  body.scrollLeft = clamp(thumbLeft / travel, 0, 1) * maxScroll
}

/** 底部编辑条坐标 → 画布本地坐标（默认取力度条画布，自动化条显式传入自己的画布） */
function laneLocal(event: PointerEvent | MouseEvent, target?: HTMLCanvasElement | null): { x: number; y: number } {
  const canvas = target ?? velocityEl.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

/** 力度条纵向位置 → 力度值 0~1（顶部为满力度） */
function laneValueAtY(y: number): number {
  const canvas = velocityEl.value
  const h = canvas?.clientHeight ?? LANE_H
  return clamp(1 - (y - 2) / (h - 4), 0, 1)
}

/** 命中测试：找到力度条上 x 位置对应的音符（取柱子中心最近的一个） */
function laneHitTest(x: number): Note | null {
  const active = region.value
  if (!active) return null
  const px = state.view.pxPerBeat
  let best: Note | null = null
  let bestDist = Infinity
  for (const note of active.notes) {
    const barW = laneBarWidth(note)
    const left = note.start * px
    if (x >= left - 4 && x <= left + barW + 4) {
      const dist = Math.abs(x - (left + barW / 2))
      if (dist < bestDist) {
        bestDist = dist
        best = note
      }
    }
  }
  return best
}

/**
 * 力度条拖拽状态：
 * 记录抓取音符的原始力度与选中集合的原始力度，
 * 拖动时以「相对抓取点的增量」整体平移，多选时保持相对强弱关系。
 */
const laneDrag: {
  active: boolean
  grabVelocity: number
  /** 抓取柱子当前的力度（0~1），拖拽期间据此绘制水平参考线 */
  value: number
  base: Map<string, number>
} = { active: false, grabVelocity: 0, value: 0, base: new Map() }

function applyLaneVelocity(y: number): void {
  const value = laneValueAtY(y)
  const delta = value - laneDrag.grabVelocity
  const entries: { id: string; velocity: number }[] = []
  for (const [id, base] of laneDrag.base) {
    entries.push({ id, velocity: base + delta })
  }
  applyNoteVelocities(entries)
  // 参考线基准：始终跟随被抓取的那根柱子（多选时其余柱子按同一增量平移）
  laneDrag.value = clamp(laneDrag.grabVelocity + delta, 0, 1)
  laneReadout.value = velocityToMidi(laneDrag.value)
  requestDraw()
}

function onLanePointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  const { x, y } = laneLocal(event)
  const hit = laneHitTest(x)
  if (!hit) {
    clearNoteSelection()
    requestDraw()
    return
  }
  if (!state.selectedNoteIds.includes(hit.id)) setNoteSelection([hit.id])

  laneDrag.active = true
  laneDrag.grabVelocity = hit.velocity
  laneDrag.base.clear()
  const ids = state.selectedNoteIds.length ? state.selectedNoteIds : [hit.id]
  for (const id of ids) {
    const note = region.value?.notes.find((n) => n.id === id)
    if (note) laneDrag.base.set(id, note.velocity)
  }
  applyLaneVelocity(y)

  window.addEventListener('pointermove', onLanePointerMove)
  window.addEventListener('pointerup', onLanePointerUp)
  window.addEventListener('pointercancel', onLanePointerUp)
}

function onLanePointerMove(event: PointerEvent): void {
  if (!laneDrag.active) return
  applyLaneVelocity(laneLocal(event).y)
}

function onLanePointerUp(): void {
  if (!laneDrag.active) return
  laneDrag.active = false
  laneDrag.base.clear()
  laneReadout.value = null
  window.removeEventListener('pointermove', onLanePointerMove)
  window.removeEventListener('pointerup', onLanePointerUp)
  window.removeEventListener('pointercancel', onLanePointerUp)
  commit()
  requestDraw()
}

// ---------------------------------------------------------------- 力度工具

function onVelocityNudge(delta: number): void {
  const count = nudgeTargetVelocity(delta)
  state.statusText = count ? `力度调整：${count} 个音符` : '没有可调整的音符'
  requestDraw()
}

function onVelocityScale(factor: number): void {
  const count = scaleTargetVelocity(factor)
  state.statusText = count ? `力度缩放 ×${factor}：${count} 个音符` : '没有可调整的音符'
  requestDraw()
}

function onVelocityHumanize(): void {
  const count = humanizeTargetVelocity(0.1)
  state.statusText = count ? `已人性化 ${count} 个音符的力度` : '没有可调整的音符'
  requestDraw()
}

function onVelocityUniform(): void {
  const count = setTargetVelocity(midiToVelocity(100))
  state.statusText = count ? `已把 ${count} 个音符力度统一为 100` : '没有可调整的音符'
  requestDraw()
}

// ---------------------------------------------------------------- 自动化包络条

/** 当前轨道指定参数的自动化曲线 */
const currentLane = computed(() =>
  track.value ? automationLane(track.value, state.automationParam) : undefined
)

/** 参数值域（用于把数值映射到纵向坐标） */
const paramRange = computed(() => AUTOMATION_PARAM_MAP[state.automationParam])

/** 横向像素 → 拍 */
function beatAtX(x: number): number {
  return Math.max(0, x / state.view.pxPerBeat)
}

/** 纵向像素 → 参数值（顶部为最大值） */
function autoValueAtY(y: number): number {
  const canvas = automationEl.value
  const h = canvas?.clientHeight ?? AUTOMATION_LANE_HEIGHT
  const range = paramRange.value
  const ratio = clamp(1 - (y - 3) / (h - 8), 0, 1)
  return range.min + ratio * (range.max - range.min)
}

/** 参数值 → 纵向像素（与 autoValueAtY 互为反函数） */
function autoYAtValue(value: number, height: number): number {
  const range = paramRange.value
  const ratio = clamp((value - range.min) / (range.max - range.min), 0, 1)
  return 3 + (1 - ratio) * (height - 8)
}

/** 命中测试：找到离触点最近的自动化点（阈值 10px，便于触屏操作） */
function lanePointAt(x: number, y: number): AutomationPoint | null {
  const lane = currentLane.value
  const canvas = automationEl.value
  if (!lane || !canvas) return null
  const h = canvas.clientHeight
  const px = state.view.pxPerBeat
  let best: AutomationPoint | null = null
  let bestDist = Infinity
  for (const point of lane.points) {
    const dx = point.beat * px - x
    const dy = autoYAtValue(point.value, h) - y
    const dist = Math.hypot(dx, dy)
    if (dist < 12 && dist < bestDist) {
      bestDist = dist
      best = point
    }
  }
  return best
}

/** 在当前播放头位置插入一个自动化点（工具条按钮用） */
function onAddAutomationPoint(): void {
  if (!track.value) return
  addAutomationPoint(track.value.id, state.automationParam, state.playheadBeats, currentValue())
  requestDraw()
}

/** 当前参数在推子上的静态值（新增点默认取它，曲线更贴近现状） */
function currentValue(): number {
  return track.value ? automationStaticValue(track.value, state.automationParam) : paramRange.value.def
}

/** 清空当前参数的自动化曲线 */
function onClearAutomation(): void {
  if (!track.value) return
  clearAutomation(track.value.id, state.automationParam)
  requestDraw()
}

/** 切换当前编辑的自动化参数 */
function onAutomationParamChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value as typeof state.automationParam
  setAutomationParam(value)
  requestDraw()
}

/** 参数读数文案：均衡用 dB，其余用百分比 */
function paramValueText(value: number): string {
  const param = state.automationParam
  if (param === 'eqLow' || param === 'eqMid' || param === 'eqHigh') return `${value.toFixed(1)} dB`
  if (param === 'pan') {
    if (Math.abs(value) < 0.01) return '居中'
    return `${value < 0 ? '左' : '右'} ${Math.round(Math.abs(value) * 100)}%`
  }
  return `${Math.round(value * 100)}%`
}

// ---------------------------------------------------------------- 音阶锁定

function onScaleTypeChange(event: Event): void {
  setScaleType((event.target as HTMLSelectElement).value as Parameters<typeof setScaleType>[0])
  requestDraw()
}

function onScaleRootChange(event: Event): void {
  setScaleRoot(Number((event.target as HTMLSelectElement).value))
  requestDraw()
}

/** 把选中音符吸附到当前音阶 */
function onQuantizeToScale(): void {
  const count = quantizeSelectedToScale()
  state.statusText = count ? `已把 ${count} 个音符吸附到音阶` : '所有选中音符都已在音阶内'
  requestDraw()
}

/** 下拉里的一次性操作：执行完顺手收起面板，避免面板挡住网格 */
function onQuantizeToScaleFromMenu(): void {
  onQuantizeToScale()
  scaleMenuEl.value?.close()
}

/** 当前音阶的显示名（根音 + 类型），直接呈现在「音阶」下拉触发器上 */
const scaleLabel = computed(() => {
  const root = SCALE_ROOT_OPTIONS.find((opt) => opt.value === state.project.scale.root)?.label ?? 'C'
  const def = SCALE_DEFS.find((item) => item.type === state.project.scale.type)
  // 十二平均律表示「不锁定」，触发器上只留根音，避免文字过长挤压工具栏
  return state.project.scale.type === 'chromatic' ? root : `${root} ${def?.label ?? ''}`.trim()
})

/** 「显示」组内是否有任一开关处于打开状态：用于让下拉触发器显示激活态 */
const anyDisplayOn = computed(
  () => state.velocityLaneOn || state.automationLaneOn || state.noteColorByVelocity
)

/** 自动化条拖拽状态 */
const autoDrag: { active: boolean; pointId: string } = { active: false, pointId: '' }

function onAutoPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !track.value) return
  const { x, y } = laneLocal(event, automationEl.value)
  const hit = lanePointAt(x, y)
  if (hit) {
    autoDrag.active = true
    autoDrag.pointId = hit.id
  } else {
    // 空白处按下：在该位置新建一个点并立即进入拖拽，写曲线时一气呵成
    addAutomationPoint(track.value.id, state.automationParam, beatAtX(x), autoValueAtY(y))
    const lane = currentLane.value
    const created = lane?.points.find((p) => Math.abs(p.beat - roundBeat(beatAtX(x))) < 0.001)
    if (!created) return
    autoDrag.active = true
    autoDrag.pointId = created.id
  }
  window.addEventListener('pointermove', onAutoPointerMove)
  window.addEventListener('pointerup', onAutoPointerUp)
  window.addEventListener('pointercancel', onAutoPointerUp)
  requestDraw()
}

function onAutoPointerMove(event: PointerEvent): void {
  if (!autoDrag.active || !track.value) return
  const { x, y } = laneLocal(event, automationEl.value)
  moveAutomationPoint(
    track.value.id,
    state.automationParam,
    autoDrag.pointId,
    beatAtX(x),
    autoValueAtY(y)
  )
  requestDraw()
}

function onAutoPointerUp(): void {
  if (!autoDrag.active) return
  autoDrag.active = false
  autoDrag.pointId = ''
  window.removeEventListener('pointermove', onAutoPointerMove)
  window.removeEventListener('pointerup', onAutoPointerUp)
  window.removeEventListener('pointercancel', onAutoPointerUp)
  requestDraw()
}

/** 在自动化点上右键（或 Pad 长按）→ 删除该点 */
function onAutoContextMenu(event: MouseEvent): void {
  event.preventDefault()
  if (!track.value) return
  const { x, y } = laneLocal(event, automationEl.value)
  const hit = lanePointAt(x, y)
  if (!hit) return
  removeAutomationPoint(track.value.id, state.automationParam, hit.id)
  requestDraw()
}

/** 绘制自动化包络条：折线连接各关键点，并标出播放头位置 */
function drawAutomation(): void {
  const canvas = automationEl.value
  if (!canvas) return
  const cssWidth = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  const ctx = prepareCanvas(canvas, cssWidth, cssHeight)
  if (!ctx) return
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // 背景与参考线（25% / 50% / 75% 处各一条，便于目测数值）
  ctx.fillStyle = '#14151a'
  ctx.fillRect(0, 0, cssWidth, cssHeight)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ;[0.25, 0.5, 0.75].forEach((ratio) => {
    ctx.fillRect(0, Math.round(cssHeight * ratio), cssWidth, 1)
  })
  ctx.fillStyle = 'rgba(255,255,255,0.16)'
  ctx.fillRect(0, 0, cssWidth, 1)

  const body = bodyEl.value
  const viewL = body?.scrollLeft ?? 0
  const px = state.view.pxPerBeat
  const value = currentValue()
  const color = trackColor.value

  // 曲线缺失时画一条虚线表示推子静态值，让用户知道从哪起步
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'
  ctx.lineWidth = 1
  const baseY = autoYAtValue(value, cssHeight)
  ctx.beginPath()
  ctx.moveTo(0, baseY + 0.5)
  ctx.lineTo(cssWidth, baseY + 0.5)
  ctx.stroke()
  ctx.setLineDash([])

  const lane = currentLane.value
  if (!lane || lane.points.length === 0) return

  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  lane.points.forEach((point, index) => {
    const x = point.beat * px
    const y = autoYAtValue(point.value, cssHeight)
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.stroke()

  for (const point of lane.points) {
    const x = point.beat * px
    if (x < viewL - 20 || x > viewL + cssWidth + 20) continue
    const y = autoYAtValue(point.value, cssHeight)
    ctx.fillStyle = autoDrag.pointId === point.id ? '#ffffff' : color
    ctx.beginPath()
    ctx.arc(x, y, autoDrag.pointId === point.id ? 5 : 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // 播放头竖线：与主网格的播放头位置对齐
  const playX = state.playheadBeats * px
  if (playX >= viewL && playX <= viewL + cssWidth) {
    ctx.fillStyle = 'rgba(255,120,120,0.85)'
    ctx.fillRect(playX, 0, 1, cssHeight)
  }
}

// ---------------------------------------------------------------- 重绘调度

let rafId = 0
let dirty = true

function requestDraw(): void {
  dirty = true
}

function loop(): void {
  const body = bodyEl.value
  // 播放时跟随播放头横向滚动，保证播放位置始终可见
  if (state.isPlaying && body) {
    const px = state.view.pxPerBeat
    const playX = state.playheadBeats * px
    const left = body.scrollLeft
    const right = left + body.clientWidth
    if (playX < left || playX > right - 40) {
      body.scrollLeft = Math.max(0, playX - body.clientWidth * 0.3)
    }
  }
  if (dirty || state.isPlaying) {
    drawGrid()
    drawKeys()
    if (state.velocityLaneOn) drawVelocity()
    if (state.automationLaneOn) drawAutomation()
    drawNav()
    dirty = false
  }
  rafId = requestAnimationFrame(loop)
}

// ---------------------------------------------------------------- 坐标换算

function localPoint(event: MouseEvent): { x: number; y: number } {
  const canvas = gridEl.value
  if (!canvas) return { x: 0, y: 0 }
  const rect = canvas.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function midiAtY(y: number): number {
  return clamp(topMidi.value - Math.floor(y / rowHeight.value), MIN_MIDI, MAX_MIDI)
}

function hitTest(x: number, y: number): Note | null {
  const active = region.value
  if (!active) return null
  const px = state.view.pxPerBeat
  const rowH = rowHeight.value
  const top = topMidi.value
  // 倒序遍历，命中最后绘制（视觉最上层）的音符
  for (let i = active.notes.length - 1; i >= 0; i -= 1) {
    const note = active.notes[i]
    const nx = note.start * px
    const nw = Math.max(3, note.duration * px)
    const ny = (top - note.midi) * rowH
    if (x >= nx && x <= nx + nw && y >= ny && y <= ny + rowH) return note
  }
  return null
}

function selectedNotes(): Note[] {
  const active = region.value
  if (!active || state.selectedNoteIds.length === 0) return []
  const ids = new Set(state.selectedNoteIds)
  return active.notes.filter((n) => ids.has(n.id))
}

function maxNoteEnd(): number {
  const active = region.value
  if (!active) return 0
  return active.notes.reduce((max, n) => Math.max(max, n.start + n.duration), 0)
}

// ---------------------------------------------------------------- 指针交互

let listenersAttached = false

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  // 触屏上浏览器可能中途接管手势并发出 pointercancel，
  // 若不当成抬起处理，拖拽状态会卡住、监听器残留
  window.addEventListener('pointercancel', onPointerUp)
}

function detachListeners(): void {
  if (!listenersAttached) return
  listenersAttached = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
}

function onPointerDown(event: PointerEvent): void {
  // 左键（0）正常交互；右键（2）由 onContextMenu 单独处理
  if (event.button !== 0) return
  // 已有手势进行中：忽略其它手指的按下，避免多指触摸互相打断
  if (activePointerId !== null && event.pointerId !== activePointerId) return
  activePointerId = event.pointerId
  // 触屏抖动大，用更大的移动容差，避免长按判定被手指抖动取消
  moveTolerance = event.pointerType === 'touch' ? MOVE_TOLERANCE_TOUCH : MOVE_TOLERANCE_MOUSE
  const { x, y } = localPoint(event)
  const beat = x / state.view.pxPerBeat
  const midi = midiAtY(y)
  const hit = hitTest(x, y)

  // 先关掉菜单（如果开着）
  closeMenu()

  if (hit) {
    const alreadySelected = state.selectedNoteIds.includes(hit.id)
    if (event.shiftKey) toggleNoteSelection(hit.id)
    else if (!alreadySelected) setNoteSelection([hit.id])

    // 靠近两端 6px 视为改时长，其余区域为移动
    const noteX = hit.start * state.view.pxPerBeat
    const noteW = Math.max(3, hit.duration * state.view.pxPerBeat)
    let resizeMode: DragMode = 'move'
    if (x - noteX <= 6) resizeMode = 'resize-start'
    else if (noteX + noteW - x <= 6) resizeMode = 'resize-end'

    // 启动长按计时：
    //  - 按时长到 → 弹出右键菜单
    //  - 移动超过阈值 → 取消计时，进入拖拽模式
    startLongPressTimer(x, y, hit)
    // 暂存目标模式，等长按取消后再真正进入
    drag.mode = 'move-pending' as DragMode
    drag.snapshots = selectedNotes().map((n) => ({
      id: n.id,
      start: n.start,
      duration: n.duration,
      midi: n.midi
    }))
    drag.originBeat = beat
    drag.originMidi = midi
    drag.pendingTarget = resizeMode
  } else if (event.shiftKey) {
    // Shift + 拖拽空白 = 框选（PC 端常用，Pad 端用长按）
    drag.mode = 'marquee'
    drag.marquee = { x0: x, y0: y, x1: x, y1: y }
    clearNoteSelection()
  } else {
    // 空白处按下：
    //  - 启动长按计时器（长按 = 框选）
    //  - 触屏 / Pad 模式：拖动 = 框选；鼠标 + PC 模式：拖动 = 新增音符并拉长
    //  - 原地抬起（未拖动）= 新增一个默认时长的音符
    startLongPressTimer(x, y, null)
    const touchLike = event.pointerType === 'touch' || state.deviceMode === 'pad'
    drag.mode = touchLike ? 'marquee-pending' : 'create-pending'
    // 以点击所在的整格为准（向下取整），而不是吸附到最近的网格线，
    // 否则点在格子右半部分时音符会跑到右边那一格
    drag.originBeat = Math.max(0, floorToGrid(beat, state.snapDivision))
    drag.originMidi = midi
  }

  drag.moved = false
  lastPreviewMidi = null
  attachListeners()
  requestDraw()
}

/**
 * 右键菜单（PC 端）
 * Pad 端通过长按触发菜单，走的是另一条路径。
 */
function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  const body = bodyEl.value
  if (!body) return
  const rect = body.getBoundingClientRect()
  const x = event.clientX - rect.left + (body.scrollLeft ?? 0)
  const y = event.clientY - rect.top
  const hit = hitTest(x, y)
  if (hit) {
    // 右键点中音符 → 选中它（未选的话）并弹菜单
    if (!state.selectedNoteIds.includes(hit.id)) setNoteSelection([hit.id])
  } else {
    // 右键空白 → 先清选中再弹菜单（方便粘贴等操作）
    clearNoteSelection()
  }
  openMenu(x, y, hit)
}

function onPointerMove(event: PointerEvent): void {
  // 忽略非主指针（多指触摸时的其它手指），避免串改当前拖拽
  if (activePointerId !== null && event.pointerId !== activePointerId) return
  const { x, y } = localPoint(event)
  const dx = Math.abs(x - longPressOrigin.x)
  const dy = Math.abs(y - longPressOrigin.y)
  const movedEnough = dx > moveTolerance || dy > moveTolerance

  // 长按计时中：移动超过容差 → 取消长按，按手势定性进入拖拽
  if (longPressTimer !== null) {
    if (movedEnough) {
      clearLongPressTimer()
      if (drag.mode === 'create-pending') {
        // PC：空白处拖动 = 新增音符并拉长（音阶锁定开启时自动吸附到工程音阶）
        const midi = snapMidi(drag.originMidi)
        const start = drag.originBeat
        const note = addNote(midi, start, state.snapDivision)
        if (note) {
          setNoteSelection([note.id])
          // 写下音符时立即试听，确认音高与音色
          previewWritten(note.midi, note.velocity)
          lastPreviewMidi = note.midi
          drag.mode = 'create'
          drag.snapshots = [{ id: note.id, start: note.start, duration: note.duration, midi: note.midi }]
        } else {
          drag.mode = 'none'
        }
      } else if (drag.mode === 'marquee-pending') {
        // Pad：空白处拖动 = 框选
        drag.mode = 'marquee'
        drag.marquee = { x0: longPressOrigin.x, y0: longPressOrigin.y, x1: x, y1: y }
        clearNoteSelection()
      } else if (drag.mode === 'move-pending') {
        // 音符上按下后移动 → 进入拖拽模式
        drag.mode = drag.pendingTarget
      }
    }
  } else if (longPressTriggered && drag.mode === 'move-pending' && movedEnough) {
    // 长按已触发（菜单已弹出）：手指继续移动 → 视为拖拽，
    // 关闭菜单并转为移动 / 改时长，避免「长按后无法拖拽音符」
    closeMenu()
    drag.mode = drag.pendingTarget
  }

  if (
    drag.mode === 'none' ||
    drag.mode === 'create-pending' ||
    drag.mode === 'marquee-pending' ||
    drag.mode === 'move-pending'
  ) {
    updateCursor(event)
    return
  }

  if (drag.mode === 'marquee' && drag.marquee) {
    drag.marquee.x1 = x
    drag.marquee.y1 = y
    requestDraw()
    return
  }

  const active = region.value
  if (!active) return
  const beat = x / state.view.pxPerBeat
  const midi = midiAtY(y)
  const step = state.snapDivision

  drag.moved = true
  for (const snapshot of drag.snapshots) {
    const note = active.notes.find((n) => n.id === snapshot.id)
    if (!note) continue

    if (drag.mode === 'move') {
      const deltaBeat = snapTo(beat - drag.originBeat, step)
      const deltaMidi = midi - drag.originMidi
      note.start = roundBeat(Math.max(0, snapshot.start + deltaBeat))
      // 音阶锁定开启时，拖动后的音高吸附到音阶内的最近音
      note.midi = snapMidi(clamp(snapshot.midi + deltaMidi, MIN_MIDI, MAX_MIDI))
    } else if (drag.mode === 'resize-end') {
      const end = Math.max(snapshot.start + step, snapTo(beat, step))
      note.duration = roundBeat(end - note.start)
    } else if (drag.mode === 'resize-start') {
      const end = snapshot.start + snapshot.duration
      const newStart = clamp(snapTo(beat, step), 0, end - step)
      note.start = roundBeat(newStart)
      note.duration = roundBeat(end - newStart)
    } else if (drag.mode === 'create') {
      const end = Math.max(snapshot.start + step, snapTo(beat, step))
      note.duration = roundBeat(end - snapshot.start)
    }
  }
  // 拖动改音高时试听：以主音符（第一个被拖的音符）为准，
  // 只在音高真正变化时发声，避免连续拖动时声音糊成一片
  if (drag.mode === 'move') {
    const primary = active.notes.find((n) => n.id === drag.snapshots[0]?.id)
    if (primary && primary.midi !== lastPreviewMidi) {
      lastPreviewMidi = primary.midi
      previewWritten(primary.midi, primary.velocity)
    }
  }
  ensureBarsForBeat(maxNoteEnd())
  requestDraw()
}

function onPointerUp(event?: PointerEvent): void {
  // 非主指针抬起：忽略（多指触摸时其它手指的抬起不应结束当前手势）
  if (event && activePointerId !== null && event.pointerId !== activePointerId) return
  activePointerId = null
  // 手势被浏览器 / 系统中断（pointercancel），而非用户主动抬起
  const cancelled = event?.type === 'pointercancel'
  // 抬起时先清掉长按计时器
  clearLongPressTimer()

  // 如果是长按触发的菜单：抬起不做拖拽收尾，菜单自己处理
  if (longPressTriggered && menuVisible.value) {
    drag.mode = 'none'
    drag.marquee = null
    drag.snapshots = []
    longPressTriggered = false
    detachListeners()
    requestDraw()
    return
  }

  // create-pending / marquee-pending 抬起 = 原地点击空白 → 新增一个默认时长的音符
  // 若手势是被系统中断（cancelled），则视为放弃，不新增音符
  if (drag.mode === 'create-pending' || drag.mode === 'marquee-pending') {
    if (!cancelled) {
      const midi = snapMidi(drag.originMidi)
      const start = drag.originBeat
      const note = addNote(midi, start, state.snapDivision)
      if (note) {
        setNoteSelection([note.id])
        // 原地点击写下音符时也立即试听
        previewWritten(note.midi, note.velocity)
        commit()
      }
    }
    drag.mode = 'none'
    drag.marquee = null
    drag.snapshots = []
    longPressTriggered = false
    detachListeners()
    requestDraw()
    return
  }

  // move-pending 抬起 = 点击（未拖拽）→ 选中状态已在 down 时处理，直接收尾
  if (drag.mode === 'move-pending') {
    drag.mode = 'none'
    drag.marquee = null
    drag.snapshots = []
    longPressTriggered = false
    detachListeners()
    requestDraw()
    return
  }

  if (drag.mode === 'marquee' && drag.marquee) {
    // 被系统中断的框选不生效，保留原有选中状态
    if (!cancelled) {
      const active = region.value
      if (active) {
        const x0 = Math.min(drag.marquee.x0, drag.marquee.x1)
        const x1 = Math.max(drag.marquee.x0, drag.marquee.x1)
        const y0 = Math.min(drag.marquee.y0, drag.marquee.y1)
        const y1 = Math.max(drag.marquee.y0, drag.marquee.y1)
        const px = state.view.pxPerBeat
        const rowH = rowHeight.value
        const top = topMidi.value
        const beatStart = x0 / px
        const beatEnd = x1 / px
        const midiHigh = top - Math.floor(y0 / rowH)
        const midiLow = top - Math.floor(y1 / rowH)
        setNoteSelection(
          active.notes
            .filter(
              (n) =>
                n.start + n.duration >= beatStart &&
                n.start <= beatEnd &&
                n.midi <= midiHigh &&
                n.midi >= midiLow
            )
            .map((n) => n.id)
        )
      }
    }
  } else if (drag.mode !== 'none') {
    if (cancelled) {
      // 手势被系统中断：把音符回滚到按下前的快照，避免留下拖到一半的错位音符
      const active = region.value
      if (drag.mode === 'create') {
        // 新增拖拽被打断 → 直接丢弃这个刚创建的音符
        if (drag.snapshots[0]) removeNotes([drag.snapshots[0].id])
      } else if (active) {
        for (const snap of drag.snapshots) {
          const note = active.notes.find((n) => n.id === snap.id)
          if (!note) continue
          note.start = snap.start
          note.duration = snap.duration
          note.midi = snap.midi
        }
      }
    } else {
      ensureBarsForBeat(maxNoteEnd())
      commit()
    }
  }

  longPressTriggered = false
  drag.mode = 'none'
  drag.marquee = null
  drag.snapshots = []
  detachListeners()
  requestDraw()
}

function updateCursor(event: PointerEvent): void {
  const body = bodyEl.value
  if (!body) return
  const { x, y } = localPoint(event)
  const hit = hitTest(x, y)
  if (!hit) {
    body.style.cursor = 'crosshair'
    return
  }
  const noteX = hit.start * state.view.pxPerBeat
  const noteW = Math.max(3, hit.duration * state.view.pxPerBeat)
  body.style.cursor = x - noteX <= 6 || noteX + noteW - x <= 6 ? 'ew-resize' : 'grab'
}

// ---------------------------------------------------------------- 滚动与缩放

function onScroll(): void {
  const body = bodyEl.value
  if (!body) return
  state.view.scrollLeft = body.scrollLeft
  requestDraw()
}

function zoomBy(factor: number, anchorX?: number): void {
  const body = bodyEl.value
  if (!body) return
  const px = state.view.pxPerBeat
  const next = clamp(px * factor, 16, 220)
  if (Math.abs(next - px) < 0.01) return

  const anchor = anchorX ?? body.clientWidth / 2
  // 记住锚点位置对应的拍，缩放后让它停留在原处
  const beatAtAnchor = (body.scrollLeft + anchor) / px
  state.view.pxPerBeat = next
  requestAnimationFrame(() => {
    body.scrollLeft = Math.max(0, beatAtAnchor * next - anchor)
    state.view.scrollLeft = body.scrollLeft
    requestDraw()
  })
}

function onWheel(event: WheelEvent): void {
  const body = bodyEl.value
  if (!body) return
  if (event.ctrlKey || event.metaKey) {
    zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - body.getBoundingClientRect().left)
    return
  }
  if (event.shiftKey) {
    const max = Math.max(0, body.scrollWidth - body.clientWidth)
    body.scrollLeft = clamp(body.scrollLeft + event.deltaY, 0, max)
    return
  }
  // 普通滚轮：纵向移动音高窗口
  const maxTop = MAX_MIDI
  const minTop = MIN_MIDI + visibleRowCount() - 1
  topMidi.value = clamp(topMidi.value + Math.sign(event.deltaY) * 2, minTop, maxTop)
  requestDraw()
}

// ---------------------------------------------------------------- 头部操作

function onGridChange(event: Event): void {
  state.snapDivision = Number((event.target as HTMLSelectElement).value) as GridDivision
  requestDraw()
}

function onQuantize(): void {
  quantizeSelected()
  requestDraw()
}

// ---------------------------------------------------------------- 琴键列试听（支持按住滑奏）

/** 按下琴键的指针 id，用于过滤多指操作 */
let keysPointerId: number | null = null
/** 当前正在发声的音高（null 表示未发声） */
let keysHeldMidi: number | null = null
/** 本次演奏所绑定的轨道 id */
let keysTrackId = ''

/**
 * 由指针纵坐标换算音高。
 * 仅在琴键列的纵向范围内有效：拖出范围返回 null 表示应当静音，
 * 这样滑出键盘就自然停声，而不是卡在边缘键上一直响。
 */
function midiAtKeysPointer(event: PointerEvent): number | null {
  const canvas = keysEl.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  if (event.clientY < rect.top || event.clientY > rect.bottom) return null
  return clamp(
    topMidi.value - Math.floor((event.clientY - rect.top) / rowHeight.value),
    MIN_MIDI,
    MAX_MIDI
  )
}

/** 释放当前发声的音符：抬手、滑奏换音、指针移出琴键都会用到 */
function releaseKeysNote(): void {
  if (keysHeldMidi === null) return
  if (keysTrackId) previewRelease(keysTrackId, keysHeldMidi)
  keysHeldMidi = null
}

/** 切换到指定音高；音高未变则不动，避免重复触发 */
function playKeysNote(midi: number | null): void {
  if (midi === keysHeldMidi) return
  releaseKeysNote()
  if (midi === null || !keysTrackId) return
  previewAttack(keysTrackId, midi)
  keysHeldMidi = midi
}

function onKeysPointerMove(event: PointerEvent): void {
  if (event.pointerId !== keysPointerId) return
  playKeysNote(midiAtKeysPointer(event))
}

/** 结束本次演奏：释放音符并摘掉全局监听 */
function endKeysAudition(): void {
  keysPointerId = null
  releaseKeysNote()
  keysTrackId = ''
  window.removeEventListener('pointermove', onKeysPointerMove)
  window.removeEventListener('pointerup', onKeysPointerUp)
  window.removeEventListener('pointercancel', onKeysPointerUp)
  window.removeEventListener('blur', endKeysAudition)
}

function onKeysPointerUp(event: PointerEvent): void {
  if (event.pointerId !== keysPointerId) return
  endKeysAudition()
}

/** 按下琴键试听音高；按住拖动即可连续滑奏 */
function onKeysPointerDown(event: PointerEvent): void {
  const canvas = keysEl.value
  const trackId = state.selectedTrackId
  if (!canvas || !trackId || event.button !== 0) return
  // 上一次演奏未正常收尾（如窗口失焦）时先清理，避免两个音叠着不释放
  if (keysPointerId !== null) endKeysAudition()
  keysPointerId = event.pointerId
  keysTrackId = trackId
  // 先挂监听再捕获指针：捕获失败也不会漏掉抬手事件，避免音符一直挂着
  window.addEventListener('pointermove', onKeysPointerMove)
  window.addEventListener('pointerup', onKeysPointerUp)
  window.addEventListener('pointercancel', onKeysPointerUp)
  window.addEventListener('blur', endKeysAudition)
  // 捕获指针：拖出琴键列后仍能收到 pointermove，滑奏不会中断
  try {
    canvas.setPointerCapture(event.pointerId)
  } catch {
    /* 某些环境（如合成事件）不支持指针捕获，退化为普通拖动即可 */
  }
  playKeysNote(midiAtKeysPointer(event))
}

// ---------------------------------------------------------------- 生命周期

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  rafId = requestAnimationFrame(loop)
  syncViewportSize()
  const host = bodyEl.value?.parentElement
  if (host) {
    resizeObserver = new ResizeObserver(() => {
      syncViewportSize()
      requestDraw()
    })
    resizeObserver.observe(host)
  }
  // 点击菜单外部关闭菜单
  window.addEventListener('pointerdown', onMenuOutsidePointerDown)
  window.addEventListener('resize', onHintResize)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  detachListeners()
  // 组件卸载时收尾：避免按住琴键切走视图后音符一直挂着
  endKeysAudition()
  window.removeEventListener('pointermove', onLanePointerMove)
  window.removeEventListener('pointerup', onLanePointerUp)
  window.removeEventListener('pointercancel', onLanePointerUp)
  window.removeEventListener('pointermove', onNavPointerMove)
  window.removeEventListener('pointerup', onNavPointerUp)
  window.removeEventListener('pointercancel', onNavPointerUp)
  window.removeEventListener('pointerdown', onMenuOutsidePointerDown)
  window.removeEventListener('resize', onHintResize)
  clearLongPressTimer()
  resizeObserver?.disconnect()
})

/** 提示弹层开着时，窗口尺寸变化需重新定位 */
function onHintResize(): void {
  if (hintOpen.value || hintHover.value) positionHint()
}

// 提示弹层显示后测量尺寸并定位
watch([hintOpen, hintHover], () => {
  if (hintOpen.value || hintHover.value) nextTick(positionHint)
})

// 切换轨道（或轨道音色变化）时自动调整音高窗口（鼓组音区较低）
watch(
  () => [state.selectedTrackId, drumLike.value],
  () => {
    if (drumLike.value) topMidi.value = 52
    else if (topMidi.value <= 52) topMidi.value = 84
    requestDraw()
  }
)

watch(
  () => [
    state.revision,
    state.view.pxPerBeat,
    state.view.rowHeight,
    state.playheadBeats,
    state.selectedNoteIds.length,
    state.activePitches.length,
    state.project.timeSignature,
    state.velocityLaneOn,
    state.noteColorByVelocity,
    // 自动化包络条展开 / 切换参数、音阶锁定与根音变化都需要重绘
    state.automationLaneOn,
    state.automationParam,
    state.project.scale.type,
    state.project.scale.root,
    state.scaleLockOn
  ],
  () => requestDraw()
)
</script>

<template>
  <section class="piano-roll">
    <!-- 卷帘小工具栏：按「轨道信息 / 编辑 / 显示 / 音阶 / 缩放」分组成簇，避免一整排控件糊成一片 -->
    <header class="pr-head">
      <!-- 轨道信息 -->
      <div class="pr-group">
        <span class="chip" :style="{ background: trackColor }" />
        <strong class="track-name">{{ track?.name ?? '未选择轨道' }}</strong>
        <span class="dim">{{ track ? INSTRUMENT_LABELS[track.instrument] : '—' }}</span>
        <span class="dim">已选 {{ state.selectedNoteIds.length }} / 共 {{ noteCount }}</span>
      </div>

      <!-- 编辑：网格、量化与音符增删 -->
      <div class="pr-group">
        <span class="group-label">编辑</span>
        <label class="field">
          网格
          <select :value="state.snapDivision" @change="onGridChange">
            <option :value="1">四分音符</option>
            <option :value="0.5">八分音符</option>
            <option :value="0.25">十六分音符</option>
            <option :value="0.125">三十二分音符</option>
          </select>
        </label>
        <button title="把选中音符（未选中则整段）对齐到网格" @click="onQuantize">量化</button>
        <button
          :disabled="state.selectedNoteIds.length === 0"
          title="删除选中的音符（也可按 Delete 键）"
          @click="deleteSelectedNotes"
        >
          删除音符
        </button>
      </div>

      <!-- 显示：底部编辑条与着色开关，收进下拉避免平铺一排 -->
      <div class="pr-group">
        <DropdownMenu
          label="显示"
          :width="212"
          :active="anyDisplayOn"
          title="显示选项：力度条 / 包络 / 力度着色"
        >
          <button
            class="dd-item"
            :class="{ on: state.velocityLaneOn }"
            title="展开 / 收起底部力度编辑条"
            @click="toggleVelocityLane"
          >
            <span class="dd-check">{{ state.velocityLaneOn ? '✓' : '' }}</span>
            <span class="dd-name">力度条</span>
            <span class="dd-desc">底部力度编辑条</span>
          </button>
          <button
            class="dd-item"
            :class="{ on: state.automationLaneOn }"
            title="展开 / 收起底部自动化包络编辑条"
            @click="toggleAutomationLane"
          >
            <span class="dd-check">{{ state.automationLaneOn ? '✓' : '' }}</span>
            <span class="dd-name">包络</span>
            <span class="dd-desc">自动化包络编辑条</span>
          </button>
          <button
            class="dd-item"
            :class="{ on: state.noteColorByVelocity }"
            title="按力度给音符着色（冷色弱、暖色强）"
            @click="toggleNoteColor"
          >
            <span class="dd-check">{{ state.noteColorByVelocity ? '✓' : '' }}</span>
            <span class="dd-name">力度着色</span>
            <span class="dd-desc">按力度给音符上色</span>
          </button>
        </DropdownMenu>
      </div>

      <!-- 音阶：类型、根音、锁定与量化，收进下拉，触发器上直接显示当前音阶 -->
      <div class="pr-group">
        <DropdownMenu
          ref="scaleMenuEl"
          :label="'音阶 · ' + scaleLabel"
          :width="236"
          :active="state.scaleLockOn"
          title="音阶设置：类型 / 根音 / 锁定与吸附"
        >
          <div class="dd-row">
            <span class="dd-row-label">类型</span>
            <select :value="state.project.scale.type" @change="onScaleTypeChange">
              <option v-for="def in SCALE_DEFS" :key="def.type" :value="def.type">{{ def.label }}</option>
            </select>
          </div>
          <div class="dd-row">
            <span class="dd-row-label">根音</span>
            <select :value="state.project.scale.root" @change="onScaleRootChange">
              <option v-for="opt in SCALE_ROOT_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <button
            class="dd-item"
            :class="{ on: state.scaleLockOn }"
            title="开启后，新增与拖动音符都会吸附到所选音阶"
            @click="toggleScaleLock"
          >
            <span class="dd-check">{{ state.scaleLockOn ? '✓' : '' }}</span>
            <span class="dd-name">锁定音阶</span>
            <span class="dd-desc">新增与拖动自动吸附</span>
          </button>
          <button
            class="dd-item"
            :disabled="state.selectedNoteIds.length === 0"
            title="把选中音符的错音吸附到当前音阶"
            @click="onQuantizeToScaleFromMenu"
          >
            <span class="dd-check">→</span>
            <span class="dd-name">吸附所选到音阶</span>
            <span class="dd-desc">把错音拉回音阶</span>
          </button>
        </DropdownMenu>
      </div>

      <span class="gap" />

      <!-- 缩放与操作提示 -->
      <div class="pr-group">
        <button title="缩小" @click="zoomBy(1 / 1.3)">－</button>
        <button title="放大" @click="zoomBy(1.3)">＋</button>

        <!-- 操作提示：收进「?」图标，悬停或点击时弹出，避免长文本挤压网格 -->
        <div
          ref="hintWrapEl"
          class="hint-wrap"
          @mouseenter="hintHover = true"
          @mouseleave="hintHover = false"
        >
          <button
            ref="hintBtnEl"
            class="hint-btn"
            :class="{ open: hintOpen || hintHover }"
            title="操作提示"
            @click="toggleHint"
          >
            ?
          </button>
          <div
            v-if="hintOpen || hintHover"
            ref="hintPopEl"
            class="hint-pop"
            :style="{ left: hintPos.x + 'px', top: hintPos.y + 'px' }"
          >
            <div class="hint-pop-title">操作提示</div>
            <template v-if="state.deviceMode === 'pad'">
              <div class="hint-line">拖动空白处框选</div>
              <div class="hint-line">拖动音符移动 / 改时长</div>
              <div class="hint-line">点按空白处新增音符</div>
              <div class="hint-line">长按音符弹出菜单</div>
              <div class="hint-line">长按后继续拖动 = 移动音符</div>
              <div class="hint-line">横向滚动用底部导航条</div>
            </template>
            <template v-else>
              <div class="hint-line">滚轮移动音高</div>
              <div class="hint-line">Shift + 滚轮左右滚动</div>
              <div class="hint-line">Ctrl + 滚轮缩放</div>
              <div class="hint-line">Shift + 拖拽框选</div>
              <div class="hint-line">右键菜单</div>
            </template>
          </div>
        </div>
      </div>
    </header>

    <div class="pr-main">
      <!-- 上：琴键列 + 音符网格 + 自绘滚动条 -->
      <div class="pr-top">
        <div class="pr-keys" :style="{ width: KEY_WIDTH + 'px', paddingBottom: SCROLLBAR_SIZE + 'px' }">
          <canvas ref="keysEl" class="keys-canvas" @pointerdown="onKeysPointerDown" />
        </div>

        <!-- 网格与横向滚动条竖向堆叠：滚动条占位与原生的 10px 一致，网格视口高度不变 -->
        <div class="pr-body-wrap">
          <div
            ref="bodyEl"
            class="pr-body"
            @scroll="onScroll"
            @wheel.prevent="onWheel"
            @pointerdown="onPointerDown"
            @contextmenu.prevent="onContextMenu"
          >
            <canvas
              ref="gridEl"
              class="grid-canvas"
              :style="{ width: totalWidth + 'px', height: '100%' }"
            />
          </div>
          <div
            ref="hbarEl"
            class="pr-hbar"
            :style="{ height: SCROLLBAR_SIZE + 'px' }"
            @pointerdown="onHScrollPointerDown"
          >
            <div class="bar-thumb" :style="{ width: hThumb.width + 'px', left: hThumb.left + 'px' }" />
          </div>
        </div>

        <!-- 竖向滚动条：高度取网格视口高度，与音符网格上下对齐 -->
        <div
          ref="vbarEl"
          class="pr-vbar"
          :style="{ width: SCROLLBAR_SIZE + 'px', height: viewportH + 'px' }"
          @pointerdown="onVScrollPointerDown"
        >
          <div class="bar-thumb" :style="{ height: vThumb.height + 'px', top: vThumb.top + 'px' }" />
        </div>
      </div>

      <!-- 下：力度编辑条（可折叠） -->
      <template v-if="state.velocityLaneOn">
        <div class="pr-velbar">
          <span class="lane-title">力度</span>
          <button title="选中音符力度 -6（未选中则作用于整段）" @click="onVelocityNudge(-0.047)">−</button>
          <button title="选中音符力度 +6" @click="onVelocityNudge(0.047)">＋</button>
          <button title="力度 ×0.8" @click="onVelocityScale(0.8)">×0.8</button>
          <button title="力度 ×1.25" @click="onVelocityScale(1.25)">×1.25</button>
          <button title="在现有力度上随机抖动 ±10，避免机械感" @click="onVelocityHumanize">人性化</button>
          <button title="把力度统一为 100（MIDI）" @click="onVelocityUniform">统一 100</button>
          <span class="gap" />
          <span class="lane-readout" :class="{ live: laneReadout !== null }">
            {{
              laneReadout !== null
                ? `力度 ${laneReadout}`
                : laneSelected
                  ? '拖动柱子调整力度'
                  : '未选中：作用于整段'
            }}
          </span>
        </div>

        <div class="pr-bottom" :style="{ height: LANE_H + 'px' }">
          <div class="pr-lane-label" :style="{ width: KEY_WIDTH + 'px' }">力度</div>
          <div class="pr-velocity" @wheel.prevent="onWheel">
            <div
              class="lane-inner"
              :style="{ width: totalWidth + 'px', transform: `translateX(${-state.view.scrollLeft}px)` }"
            >
              <canvas
                ref="velocityEl"
                class="lane-canvas"
                :style="{ width: totalWidth + 'px', height: '100%' }"
                @pointerdown="onLanePointerDown"
              />
            </div>
          </div>
        </div>
      </template>

      <!-- 下：自动化包络编辑条（可折叠） -->
      <template v-if="state.automationLaneOn">
        <div class="pr-velbar">
          <span class="lane-title">包络</span>
          <label class="field">
            参数
            <select :value="state.automationParam" @change="onAutomationParamChange">
              <option v-for="item in AUTOMATION_PARAMS" :key="item.key" :value="item.key">
                {{ item.label }}
              </option>
            </select>
          </label>
          <button title="在播放头位置插入一个自动化点" @click="onAddAutomationPoint">加点</button>
          <button :disabled="!currentLane" title="清除当前参数的整条曲线" @click="onClearAutomation">
            清除
          </button>
          <span class="dim">空白处点击 / 拖动新增点，拖圆点改位置，右键删除点</span>
          <span class="gap" />
          <span class="lane-readout">
            当前 {{ paramValueText(currentValue()) }}
          </span>
        </div>

        <div class="pr-bottom" :style="{ height: AUTOMATION_LANE_HEIGHT + 'px' }">
          <div class="pr-lane-label" :style="{ width: KEY_WIDTH + 'px' }">包络</div>
          <div class="pr-velocity" @wheel.prevent="onWheel">
            <div
              class="lane-inner"
              :style="{ width: totalWidth + 'px', transform: `translateX(${-state.view.scrollLeft}px)` }"
            >
              <canvas
                ref="automationEl"
                class="lane-canvas"
                :style="{ width: totalWidth + 'px', height: '100%' }"
                @pointerdown="onAutoPointerDown"
                @contextmenu.prevent="onAutoContextMenu"
              />
            </div>
          </div>
        </div>
      </template>

      <!-- 底部横向缩略导航条：缩略显示整首歌，拖动视口窗口快速定位 -->
      <div class="pr-nav" :style="{ height: NAV_HEIGHT + 'px' }">
        <div class="pr-nav-label" :style="{ width: KEY_WIDTH + 'px' }">导航</div>
        <div ref="navHostEl" class="pr-nav-host" @pointerdown="onNavPointerDown">
          <canvas ref="navCanvasEl" class="nav-canvas" />
        </div>
      </div>
    </div>

    <!-- 右键 / 长按菜单 -->
    <div
      v-if="menuVisible"
      ref="menuEl"
      class="ctx-menu"
      :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
      @pointerdown.stop
    >
      <div class="ctx-title">
        {{ menuHitNote ? '音符操作' : '编辑' }}
        <span class="ctx-count" v-if="state.selectedNoteIds.length > 0">
          已选 {{ state.selectedNoteIds.length }}
        </span>
      </div>
      <button class="ctx-item" @click="menuSelectAll">全选</button>
      <div class="ctx-sep" />
      <button class="ctx-item" @click="menuCopy">复制</button>
      <button class="ctx-item" @click="menuCut">剪切</button>
      <button class="ctx-item" @click="menuPaste">粘贴</button>
      <button class="ctx-item" @click="menuDuplicate">拷贝</button>
      <div class="ctx-sep" />
      <button class="ctx-item" :disabled="state.selectedNoteIds.length === 0" @click="menuDelete">
        删除
      </button>
      <button class="ctx-item" :disabled="state.selectedNoteIds.length === 0" @click="menuQuantize">
        量化
      </button>
      <div class="ctx-sep" />
      <div class="ctx-sub">力度</div>
      <button class="ctx-item" @click="menuVelUp">力度 +6</button>
      <button class="ctx-item" @click="menuVelDown">力度 −6</button>
      <button class="ctx-item" @click="menuVelHumanize">人性化</button>
    </div>
  </section>
</template>

<style scoped>
.piano-roll {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: #1c1e24;
}

.pr-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  row-gap: 5px;
}

/*
 * 工具栏分组：同类控件收进一个 .pr-group。
 * 分组在父容器里是「一个整体」，父容器换行时不会被拆散，
 * 因此窄屏下不会出现「力度条留在上一行、包络掉到下一行」的错位。
 * 内部仍允许换行：万一某个分组自身宽过一整行，宁可组内折行也不要横向溢出。
 */
.pr-group {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.pr-group + .pr-group {
  margin-left: 6px;
}

/* 分组前缀标签（编辑 / 显示 / 音阶），用弱化色，只做归类提示不抢视线 */
.group-label {
  color: var(--text-dim);
  font-size: 11px;
  letter-spacing: 0.06em;
}

/* ---- 下拉面板内的条目 ----
 * 这些是 DropdownMenu 插槽里的内容，编译在本组件作用域内，因此样式写在这里。
 */
.dd-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  /* 面板内的条目按「列表项」呈现：去掉全局按钮的底色与描边，只留悬停高亮 */
  min-height: 0;
  background: transparent;
  border: 0;
  padding: 5px 6px;
  border-radius: var(--radius);
  text-align: left;
  transition: background 0.16s ease, color 0.16s ease;
}

.dd-item:hover:not(:disabled) {
  background: var(--panel-hover);
}

.dd-item:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/* 已开启的开关项：勾选符号与文字统一用强调色 */
.dd-item.on,
.dd-item.on .dd-check {
  color: var(--accent);
}

.dd-check {
  flex: 0 0 12px;
  width: 12px;
  text-align: center;
  color: var(--accent);
}

.dd-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}

.dd-desc {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11px;
}

.dd-item.on .dd-desc {
  color: var(--text-dim);
}

/* 带标签的一行（音阶类型 / 根音下拉） */
.dd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
}

.dd-row-label {
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11px;
}

.dd-row select {
  flex: 1;
  min-width: 0;
}

.chip {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.track-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dim {
  color: var(--text-dim);
}

/* ---- 操作提示：「?」图标 + 弹出层 ---- */
.hint-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.hint-btn {
  width: 24px;
  min-width: 24px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border-radius: 50%;
  font-weight: 700;
  line-height: 1;
  color: var(--text-dim);
}

.hint-btn.open {
  color: var(--accent);
  border-color: var(--accent);
}

/* 弹层位置由 JS 计算（position: fixed），用视口边界兜底，避免被卷帘面板裁切 */
.hint-pop {
  position: fixed;
  z-index: 260;
  min-width: 178px;
  padding: 7px 9px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: var(--panel-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  animation: hint-pop 0.14s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes hint-pop {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.hint-pop-title {
  margin-bottom: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}

.hint-line {
  font-size: 12px;
  white-space: nowrap;
  color: var(--text);
}

.gap {
  flex: 1;
}

.field {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
}

.pr-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* 上半部分：琴键列 + 音符网格 */
.pr-top {
  display: flex;
  flex: 1;
  min-height: 0;
}

.pr-keys {
  flex: 0 0 auto;
  overflow: hidden;
  background: #141519;
  border-right: 1px solid var(--line);
  touch-action: none;
}

.keys-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
  touch-action: none;
}

/* 网格 + 横向滚动条：竖向堆叠，滚动条占位与原生滚动条一致（10px） */
.pr-body-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.pr-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-x: auto;
  overflow-y: hidden;
  position: relative;
  /* 触屏关键：禁用浏览器原生手势接管。否则单指拖动会被当作滚动，
     浏览器随即发出 pointercancel，长按框选 / 拖拽音符都会被中途打断。
     横向滚动改由自绘的 .pr-hbar 与底部缩略导航条承担。 */
  touch-action: none;
  user-select: none;
  -webkit-touch-callout: none;
  /* 隐藏原生滚动条但保留 scrollLeft 能力：滚动条外观交给 .pr-hbar 自绘 */
  scrollbar-width: none;
}

.pr-body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* ---- 自绘滚动条（横向 / 竖向） ---- */
.pr-hbar,
.pr-vbar {
  position: relative;
  flex: 0 0 auto;
  touch-action: none;
}

.pr-hbar {
  box-shadow: inset 0 1px 0 var(--line);
}

.pr-vbar {
  align-self: flex-start;
  box-shadow: inset 1px 0 0 var(--line);
}

/* 滑块：尺寸与位置由脚本按视口比例算出，外观对齐全局原生滚动条样式 */
.bar-thumb {
  position: absolute;
  border-radius: 5px;
  background: #3a4050;
  transition: background 0.16s ease;
}

.pr-hbar .bar-thumb {
  top: 2px;
  bottom: 2px;
}

.pr-vbar .bar-thumb {
  left: 2px;
  right: 2px;
}

.bar-thumb:hover {
  background: #4d5470;
}

.grid-canvas {
  display: block;
  touch-action: none;
}

/* 力度编辑条工具行 */
.pr-velbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--panel);
  border-top: 1px solid var(--line);
  flex: 0 0 auto;
  flex-wrap: wrap;
  row-gap: 4px;
}

.lane-title {
  color: var(--text-dim);
  font-size: 11px;
}

.lane-readout {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.lane-readout.live {
  color: var(--accent);
  font-weight: 600;
}

/* 力度编辑条本体 */
.pr-bottom {
  display: flex;
  flex: 0 0 auto;
  border-top: 1px solid var(--line);
  background: #14151a;
}

.pr-lane-label {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 4px;
  font-size: 11px;
  color: var(--text-dim);
  border-right: 1px solid var(--line);
}

.pr-velocity {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  position: relative;
  touch-action: none;
}

.lane-inner {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  will-change: transform;
}

.lane-canvas {
  display: block;
  cursor: ns-resize;
}

/* ---- 底部横向缩略导航条 ---- */
.pr-nav {
  display: flex;
  flex: 0 0 auto;
  border-top: 1px solid var(--line);
  background: #14151a;
}

.pr-nav-label {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-dim);
  border-right: 1px solid var(--line);
}

.pr-nav-host {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.pr-nav-host:active {
  cursor: grabbing;
}

.nav-canvas {
  /* 绝对定位：脱离文档流，避免画布固有尺寸（= 位图宽度 × DPR）反过来撑大
     容器的 min-content，进而把整个卷帘面板顶宽 */
  position: absolute;
  inset: 0;
  display: block;
}

/* 右键 / 长按菜单 */
.ctx-menu {
  position: fixed;
  z-index: 200;
  min-width: 156px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.ctx-title {
  padding: 6px 10px 4px;
  font-size: 11px;
  color: var(--text-dim);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ctx-count {
  font-size: 10px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.ctx-item {
  text-align: left;
  padding: 6px 10px;
  font-size: 12px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text);
  cursor: pointer;
}

.ctx-item:hover:not(:disabled) {
  background: var(--panel-3);
}

.ctx-item:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.ctx-sep {
  height: 1px;
  background: var(--line);
  margin: 3px 4px;
}

.ctx-sub {
  padding: 4px 10px 2px;
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
</style>
