<script setup lang="ts">
/**
 * 钢琴卷帘（Canvas）
 * - 纵向：MIDI 音高 C0~C7；横向：小节网格
 * - 交互：点击新增、拖拽移动、拖两端改时长、右键/Delete 删除、框选、一键量化
 * - 只绘制视口内的行与音符，保证大量音符时依然流畅
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import type { GridDivision, Note } from '@/types'
import { INSTRUMENT_LABELS } from '@/types'
import {
  activeRegion,
  activeTrack,
  addNote,
  applyNoteVelocities,
  clearNoteSelection,
  commit,
  copySelectedNotes,
  cutSelectedNotes,
  deleteSelectedNotes,
  duplicateSelectedNotes,
  ensureBarsForBeat,
  humanizeTargetVelocity,
  nudgeTargetVelocity,
  pasteNotes,
  previewAttack,
  quantizeSelected,
  removeNotes,
  scaleTargetVelocity,
  selectAllNotes,
  setNoteSelection,
  setTargetVelocity,
  state,
  toggleNoteColor,
  toggleNoteSelection,
  toggleVelocityLane
} from '@/core/store'
import { MAX_MIDI, MIN_MIDI, beatsPerBarOf, clamp, isBlackKey, midiToNoteName, roundBeat, snapTo } from '@/utils/music'
import { midiToVelocity, velocityToMidi } from '@/utils/audio'
import { hexToRgba } from '@/utils/color'
import { KEY_WIDTH, SCROLLBAR_SIZE, VELOCITY_LANE_HEIGHT } from '@/utils/layout'

const bodyEl = ref<HTMLDivElement | null>(null)
const gridEl = ref<HTMLCanvasElement | null>(null)
const keysEl = ref<HTMLCanvasElement | null>(null)
const velocityEl = ref<HTMLCanvasElement | null>(null)

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
      drag.mode = 'marquee'
      drag.marquee = { x0: longPressOrigin.x, y0: longPressOrigin.y, x1: longPressOrigin.x, y1: longPressOrigin.y }
      clearNoteSelection()
      requestDraw()
    }
  }, longPressMs.value)
}

/** 在视口指定位置打开右键菜单 */
function openMenu(localX: number, localY: number, hitNote: Note | null): void {
  const body = bodyEl.value
  if (!body) return
  const rect = body.getBoundingClientRect()
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

/** 点击菜单外部关闭 */
function onMenuOutsidePointerDown(event: PointerEvent): void {
  if (!menuEl.value) return
  if (menuEl.value.contains(event.target as Node)) return
  closeMenu()
}

/** 视口顶部对应的 MIDI 音号（数值越大音越高，画布 y 越小） */
const topMidi = ref(84)

const rowHeight = computed(() => state.view.rowHeight)
const track = computed(() => activeTrack())
const region = computed(() => activeRegion())
const trackColor = computed(() => track.value?.color ?? '#4f9df7')
const totalBeats = computed(() => state.project.bars * beatsPerBarOf(state.project.timeSignature))
const totalWidth = computed(() => Math.max(200, totalBeats.value * state.view.pxPerBeat))
const noteCount = computed(() => region.value?.notes.length ?? 0)

type DragMode = 'none' | 'create' | 'create-pending' | 'move' | 'move-pending' | 'resize-end' | 'resize-start' | 'marquee'

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
      ctx.font = 'bold 9px system-ui, sans-serif'
      ctx.fillStyle = black ? '#eef1f6' : '#3d4252'
      ctx.fillText(midiToNoteName(midi), 4, y + rowH / 2)
      ctx.font = '9px system-ui, sans-serif'
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
}

/** 力度条坐标 → 画布本地坐标 */
function laneLocal(event: PointerEvent): { x: number; y: number } {
  const canvas = velocityEl.value
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
  base: Map<string, number>
} = { active: false, grabVelocity: 0, base: new Map() }

function applyLaneVelocity(y: number): void {
  const value = laneValueAtY(y)
  const delta = value - laneDrag.grabVelocity
  const entries: { id: string; velocity: number }[] = []
  for (const [id, base] of laneDrag.base) {
    entries.push({ id, velocity: base + delta })
  }
  applyNoteVelocities(entries)
  laneReadout.value = velocityToMidi(clamp(laneDrag.grabVelocity + delta, 0, 1))
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
}

function detachListeners(): void {
  if (!listenersAttached) return
  listenersAttached = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
}

function onPointerDown(event: PointerEvent): void {
  // 左键（0）正常交互；右键（2）由 onContextMenu 单独处理
  if (event.button !== 0) return
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
    //  - 先启动长按计时器（Pad 端长按 = 框选；PC 端也支持）
    //  - 如果提前抬起（没到长按时长），则当作「新增音符」
    startLongPressTimer(x, y, null)
    drag.mode = 'create-pending'
    drag.originBeat = Math.max(0, snapTo(beat, state.snapDivision))
    drag.originMidi = midi
  }

  drag.moved = false
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
  const { x, y } = localPoint(event)

  // 长按计时中：如果移动超过阈值，取消长按，当作普通拖拽
  if (longPressTimer !== null) {
    const dx = Math.abs(x - longPressOrigin.x)
    const dy = Math.abs(y - longPressOrigin.y)
    // 移动超过 6px 视为用户在拖拽，取消长按
    if (dx > 6 || dy > 6) {
      clearLongPressTimer()
      // 如果是 create-pending（空白处按下后移动），转为「新增音符」模式
      if (drag.mode === 'create-pending') {
        const midi = drag.originMidi
        const start = drag.originBeat
        const note = addNote(midi, start, state.snapDivision)
        if (note) {
          setNoteSelection([note.id])
          drag.mode = 'create'
          drag.snapshots = [{ id: note.id, start: note.start, duration: note.duration, midi: note.midi }]
        } else {
          drag.mode = 'none'
        }
      } else if (drag.mode === 'move-pending') {
        // 音符上按下后移动 → 进入拖拽模式
        drag.mode = drag.pendingTarget
      }
    }
  }

  if (drag.mode === 'none' || drag.mode === 'create-pending' || drag.mode === 'move-pending') {
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
      note.midi = clamp(snapshot.midi + deltaMidi, MIN_MIDI, MAX_MIDI)
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
  ensureBarsForBeat(maxNoteEnd())
  requestDraw()
}

function onPointerUp(): void {
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

  // create-pending 抬起 = 快速点击空白 → 新增一个默认时长的音符
  if (drag.mode === 'create-pending') {
    const midi = drag.originMidi
    const start = drag.originBeat
    const note = addNote(midi, start, state.snapDivision)
    if (note) {
      setNoteSelection([note.id])
      commit()
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
  } else if (drag.mode !== 'none') {
    ensureBarsForBeat(maxNoteEnd())
    commit()
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

/** 点击琴键列试听音高 */
function onKeysPointerDown(event: PointerEvent): void {
  const canvas = keysEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const midi = clamp(topMidi.value - Math.floor((event.clientY - rect.top) / rowHeight.value), MIN_MIDI, MAX_MIDI)
  const trackId = state.selectedTrackId
  if (trackId) previewAttack(trackId, midi)
}

// ---------------------------------------------------------------- 生命周期

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  rafId = requestAnimationFrame(loop)
  const host = bodyEl.value?.parentElement
  if (host) {
    resizeObserver = new ResizeObserver(() => requestDraw())
    resizeObserver.observe(host)
  }
  // 点击菜单外部关闭菜单
  window.addEventListener('pointerdown', onMenuOutsidePointerDown)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  detachListeners()
  window.removeEventListener('pointermove', onLanePointerMove)
  window.removeEventListener('pointerup', onLanePointerUp)
  window.removeEventListener('pointerdown', onMenuOutsidePointerDown)
  clearLongPressTimer()
  resizeObserver?.disconnect()
})

// 切换轨道时自动调整音高窗口（鼓组音区较低）
watch(
  () => state.selectedTrackId,
  () => {
    const current = track.value
    if (current?.instrument === 'drums') topMidi.value = 52
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
    state.noteColorByVelocity
  ],
  () => requestDraw()
)
</script>

<template>
  <section class="piano-roll">
    <!-- 卷帘小工具栏 -->
    <header class="pr-head">
      <span class="chip" :style="{ background: trackColor }" />
      <strong class="track-name">{{ track?.name ?? '未选择轨道' }}</strong>
      <span class="dim">{{ track ? INSTRUMENT_LABELS[track.instrument] : '—' }}</span>

      <span class="gap" />

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
        :class="{ active: state.velocityLaneOn }"
        title="展开 / 收起底部力度编辑条"
        @click="toggleVelocityLane"
      >
        力度条
      </button>
      <button
        :class="{ active: state.noteColorByVelocity }"
        title="按力度给音符着色（冷色弱、暖色强）"
        @click="toggleNoteColor"
      >
        力度着色
      </button>
      <button
        :disabled="state.selectedNoteIds.length === 0"
        title="删除选中的音符（也可按 Delete 键）"
        @click="deleteSelectedNotes"
      >
        删除音符
      </button>
      <span class="dim">已选 {{ state.selectedNoteIds.length }} / 共 {{ noteCount }}</span>

      <span class="gap" />

      <button title="缩小" @click="zoomBy(1 / 1.3)">－</button>
      <button title="放大" @click="zoomBy(1.3)">＋</button>
      <span class="dim hint">
        {{
          state.deviceMode === 'pad'
            ? '长按空白拖拽框选 · 长按音符弹菜单 · 双指缩放'
            : '滚轮移动音高 · Shift+滚轮左右滚动 · Ctrl+滚轮缩放 · Shift+拖拽框选 · 右键菜单'
        }}
      </span>
    </header>

    <div class="pr-main">
      <!-- 上：琴键列 + 音符网格 -->
      <div class="pr-top">
        <div class="pr-keys" :style="{ width: KEY_WIDTH + 'px', paddingBottom: SCROLLBAR_SIZE + 'px' }">
          <canvas ref="keysEl" class="keys-canvas" @pointerdown="onKeysPointerDown" />
        </div>

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
      <button class="ctx-item" @click="menuDuplicate">再制</button>
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

.hint {
  font-size: 12px;
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
}

.keys-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
}

.pr-body {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  position: relative;
}

.grid-canvas {
  display: block;
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
