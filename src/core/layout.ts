/**
 * 布局与板块编排
 *
 * 设计：
 * - 界面划分为三个区域（左栏 / 中央主区 / 底部栏），每个区域是一个弹性容器，
 *   内部按顺序排列若干「功能板块」，板块可在区域内排序，也可跨区域互换。
 * - 区域尺寸（左栏宽、底部高）支持拖拽区域之间的分隔条调整。
 * - 板块尺寸（同一区域内各板块占主轴的比例）支持拖拽板块之间的分隔条调整。
 * - 布局配置持久化到 localStorage，刷新后保持不变。
 * - 编辑模式（从设置页进入）下，板块顶部出现拖拽标题栏，并显示插入位置指示线。
 *
 * 拖拽采用 Pointer Events 实现（同时兼容鼠标与触屏），
 * 通过 document 上的区域/板块 DOM 做命中判定，避免维护大量 ref。
 */
import { reactive, ref } from 'vue'
import type { LayoutConfig, PanelId, RegionId } from '@/types'

/** 板块显示名（编辑模式标题栏、拖拽提示使用） */
export const PANEL_LABELS: Record<PanelId, string> = {
  tracks: '轨道',
  fx: '效果器',
  editor: '编辑区',
  inspector: '音符检查器',
  keyboard: '虚拟键盘',
  master: '总输出'
}

/** 区域渲染顺序 */
export const REGION_ORDER: RegionId[] = ['left', 'center', 'bottom']

/** 全部板块（用于布局归一化兜底） */
const ALL_PANELS: PanelId[] = ['tracks', 'fx', 'editor', 'inspector', 'keyboard', 'master']

/** 区域尺寸约束 */
export const LEFT_WIDTH_MIN = 200
export const LEFT_WIDTH_MAX = 560
export const BOTTOM_HEIGHT_MIN = 96
export const BOTTOM_HEIGHT_MAX = 420

/** 板块尺寸权重约束（相对于区域内其他板块的主轴占比） */
export const PANEL_WEIGHT_MIN = 0.2
export const PANEL_WEIGHT_MAX = 12

/** 板块之间的分隔条宽度（px），与 DockRegion 中样式保持一致 */
export const PANEL_SPLIT_SIZE = 6

/** 板块主轴最小尺寸（px），避免被拖到不可见 */
export const PANEL_MIN_MAIN = 56

const LAYOUT_KEY = 'muisc-editor:v1:layout'

/**
 * 默认板块权重：
 * 左栏「轨道 / 效果器 / 音符检查器」等分；底部「虚拟键盘 : 总输出 = 3 : 1」，
 * 与旧版「总输出固定 232px」的观感基本一致。
 */
export function defaultPanelWeight(): Record<PanelId, number> {
  return { tracks: 1, fx: 1, editor: 1, inspector: 1, keyboard: 3, master: 1 }
}

/** 默认布局：与旧版三栏结构基本一致，音符检查器作为独立板块挂在左栏底部 */
export function defaultLayout(): LayoutConfig {
  return {
    left: ['tracks', 'fx', 'inspector'],
    center: ['editor'],
    bottom: ['keyboard', 'master'],
    leftWidth: 288,
    bottomHeight: 152,
    panelWeight: defaultPanelWeight()
  }
}

function clampSize(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 布局归一化：保证每个板块恰好出现一次、未知板块剔除、缺失板块补回默认区域，
 * 这样即使 localStorage 里的数据被手工改坏，界面也不会出现板块丢失或重复。
 */
function normalizeLayout(raw: Partial<LayoutConfig> | null): LayoutConfig {
  const base = defaultLayout()
  if (!raw) return base

  const seen = new Set<PanelId>()
  const result: LayoutConfig = {
    left: [],
    center: [],
    bottom: [],
    leftWidth: 0,
    bottomHeight: 0,
    panelWeight: defaultPanelWeight()
  }

  for (const region of REGION_ORDER) {
    const list = Array.isArray(raw[region]) ? (raw[region] as PanelId[]) : []
    for (const id of list) {
      if (ALL_PANELS.includes(id) && !seen.has(id)) {
        seen.add(id)
        result[region].push(id)
      }
    }
  }
  for (const region of REGION_ORDER) {
    for (const id of base[region]) {
      if (!seen.has(id)) {
        seen.add(id)
        result[region].push(id)
      }
    }
  }

  result.leftWidth = clampSize(raw.leftWidth, base.leftWidth, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX)
  result.bottomHeight = clampSize(raw.bottomHeight, base.bottomHeight, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX)

  // 板块权重：逐项兜底，缺字段的老工程自动补默认值
  const rawWeight = raw.panelWeight as Partial<Record<PanelId, number>> | undefined
  for (const id of ALL_PANELS) {
    result.panelWeight[id] = clampSize(
      rawWeight?.[id],
      base.panelWeight[id],
      PANEL_WEIGHT_MIN,
      PANEL_WEIGHT_MAX
    )
  }
  return result
}

function loadLayout(): LayoutConfig {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    return normalizeLayout(raw ? (JSON.parse(raw) as Partial<LayoutConfig>) : null)
  } catch {
    return defaultLayout()
  }
}

/** 当前布局（响应式） */
export const layout = reactive<LayoutConfig>(loadLayout())

/** 编辑模式与拖拽过程中的临时状态（不持久化） */
export const layoutUi = reactive({
  editMode: false,
  dragPanel: null as PanelId | null,
  dropRegion: null as RegionId | null,
  dropIndex: -1
})

/** 插入位置指示线：region + 相对区域的像素偏移 + 方向 */
export const dropLine = ref<{ region: RegionId; offset: number; horizontal: boolean } | null>(null)

function persist(): void {
  try {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        left: layout.left,
        center: layout.center,
        bottom: layout.bottom,
        leftWidth: layout.leftWidth,
        bottomHeight: layout.bottomHeight,
        panelWeight: layout.panelWeight
      })
    )
  } catch {
    // 忽略存储配额异常，布局丢失不影响功能
  }
}

/** 进入 / 退出布局编辑模式 */
export function setEditMode(on: boolean): void {
  layoutUi.editMode = on
  if (!on) {
    endDrag()
    stopPanelResize()
  }
}

/** 恢复默认布局与默认尺寸 */
export function resetLayout(): void {
  const base = defaultLayout()
  layout.left = base.left
  layout.center = base.center
  layout.bottom = base.bottom
  layout.leftWidth = base.leftWidth
  layout.bottomHeight = base.bottomHeight
  layout.panelWeight = base.panelWeight
  persist()
}

/**
 * 把板块移动到目标区域的指定下标。
 * 下标基于「不包含被拖拽板块」的列表，因此先移除再插入即可，
 * 与拖拽时命中判定的口径保持一致。
 */
export function movePanel(panel: PanelId, target: RegionId, index: number): void {
  for (const region of REGION_ORDER) {
    const i = layout[region].indexOf(panel)
    if (i >= 0) layout[region].splice(i, 1)
  }
  const list = layout[target]
  const at = Math.max(0, Math.min(index, list.length))
  list.splice(at, 0, panel)
  persist()
}

/** 设置左栏宽度（会被约束在允许范围内） */
export function setLeftWidth(px: number): void {
  layout.leftWidth = clampSize(px, layout.leftWidth, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX)
  persist()
}

/** 设置底部栏高度（会被约束在允许范围内） */
export function setBottomHeight(px: number): void {
  layout.bottomHeight = clampSize(px, layout.bottomHeight, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX)
  persist()
}

// ---------------------------------------------------------------- 拖拽编排

function regionEl(region: RegionId): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.dock-region[data-region="${region}"]`)
}

/** 计算插入下标：与各板块中心线比较（底部区域横向，其余纵向） */
function indexAt(region: RegionId, clientX: number, clientY: number): number {
  const el = regionEl(region)
  if (!el) return 0
  // 排除正在拖拽的板块，使下标口径与 movePanel 一致
  const panels = Array.from(el.querySelectorAll<HTMLElement>('.dock-panel:not(.dragging)'))
  const horizontal = region === 'bottom'
  let index = panels.length
  for (let i = 0; i < panels.length; i += 1) {
    const rect = panels[i].getBoundingClientRect()
    const mid = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2
    const pos = horizontal ? clientX : clientY
    if (pos < mid) {
      index = i
      break
    }
  }
  return index
}

/** 计算插入指示线相对目标区域的偏移，用于绝对定位绘制 */
function updateDropLine(region: RegionId, index: number): void {
  const el = regionEl(region)
  if (!el) {
    dropLine.value = null
    return
  }
  const regionRect = el.getBoundingClientRect()
  const panels = Array.from(el.querySelectorAll<HTMLElement>('.dock-panel:not(.dragging)'))
  const horizontal = region === 'bottom'

  if (panels.length === 0) {
    dropLine.value = { region, offset: horizontal ? regionRect.width / 2 : regionRect.height / 2, horizontal }
    return
  }

  let offset: number
  if (index <= 0) {
    const rect = panels[0].getBoundingClientRect()
    offset = (horizontal ? rect.left : rect.top) - (horizontal ? regionRect.left : regionRect.top)
  } else if (index >= panels.length) {
    const rect = panels[panels.length - 1].getBoundingClientRect()
    offset = (horizontal ? rect.right : rect.bottom) - (horizontal ? regionRect.left : regionRect.top)
  } else {
    const prev = panels[index - 1].getBoundingClientRect()
    const next = panels[index].getBoundingClientRect()
    offset = horizontal
      ? (prev.right + next.left) / 2 - regionRect.left
      : (prev.bottom + next.top) / 2 - regionRect.top
  }
  dropLine.value = { region, offset, horizontal }
}

/** 根据指针位置更新当前落点区域、下标与指示线 */
function updateDropTarget(clientX: number, clientY: number): void {
  for (const region of REGION_ORDER) {
    const el = regionEl(region)
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) continue
    const index = indexAt(region, clientX, clientY)
    layoutUi.dropRegion = region
    layoutUi.dropIndex = index
    updateDropLine(region, index)
    return
  }
  layoutUi.dropRegion = null
  layoutUi.dropIndex = -1
  dropLine.value = null
}

let dragging = false

function onDragMove(event: PointerEvent): void {
  if (!dragging) return
  updateDropTarget(event.clientX, event.clientY)
}

function onDragEnd(): void {
  const panel = layoutUi.dragPanel
  if (panel && layoutUi.dropRegion && layoutUi.dropIndex >= 0) {
    movePanel(panel, layoutUi.dropRegion, layoutUi.dropIndex)
  }
  endDrag()
}

function onDragKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') endDrag()
}

function endDrag(): void {
  if (!dragging) {
    layoutUi.dragPanel = null
    layoutUi.dropRegion = null
    layoutUi.dropIndex = -1
    dropLine.value = null
    return
  }
  dragging = false
  layoutUi.dragPanel = null
  layoutUi.dropRegion = null
  layoutUi.dropIndex = -1
  dropLine.value = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('keydown', onDragKey)
}

/** 从板块标题栏开始拖拽 */
export function startPanelDrag(event: PointerEvent, panel: PanelId): void {
  if (!layoutUi.editMode) return
  event.preventDefault()
  layoutUi.dragPanel = panel
  layoutUi.dropRegion = null
  layoutUi.dropIndex = -1
  dropLine.value = null
  dragging = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('keydown', onDragKey)
  updateDropTarget(event.clientX, event.clientY)
}

// ---------------------------------------------------------------- 板块尺寸调整
// 同一区域内相邻板块之间渲染一条分隔条，拖拽它改变两者的主轴占比。
// 尺寸以「权重」形式存储：板块主轴尺寸 = 可用主轴长 × 权重 / 同区域权重之和，
// 因此窗口缩放时各板块按比例自适应，不会出现空隙或溢出。

/** 一次板块尺寸拖拽的上下文快照 */
interface ResizeContext {
  region: RegionId
  /** 分隔条前后两个相邻板块 */
  a: PanelId
  b: PanelId
  /** 指针起始坐标（主轴方向） */
  startPos: number
  /** 两个板块起始时的主轴像素尺寸 */
  startA: number
  startB: number
  /** 拖拽开始时该区域所有板块的权重之和（保持不变，保证其余板块不受影响） */
  totalWeight: number
  /** 该区域可用于排布板块的主轴长度（已扣除板块之间的分隔条） */
  available: number
  horizontal: boolean
}

let resizeCtx: ResizeContext | null = null

/** 该区域主轴方向（横向区域看宽度，纵向区域看高度） */
function isHorizontalRegion(region: RegionId): boolean {
  return region === 'bottom'
}

/** 开始拖拽板块之间的分隔条，调整相邻两个板块的宽高 */
export function startPanelResize(event: PointerEvent, region: RegionId, index: number): void {
  if (!layoutUi.editMode) return
  event.preventDefault()
  const list = layout[region]
  const a = list[index]
  const b = list[index + 1]
  const el = regionEl(region)
  if (!a || !b || !el) return

  const elA = el.querySelector<HTMLElement>(`.dock-panel[data-panel="${a}"]`)
  const elB = el.querySelector<HTMLElement>(`.dock-panel[data-panel="${b}"]`)
  if (!elA || !elB) return

  const horizontal = isHorizontalRegion(region)
  const rectA = elA.getBoundingClientRect()
  const rectB = elB.getBoundingClientRect()
  const startA = horizontal ? rectA.width : rectA.height
  const startB = horizontal ? rectB.width : rectB.height

  const regionMain = horizontal ? el.clientWidth : el.clientHeight
  // 扣除板块之间的分隔条占位，使权重换算出的像素尺寸与实际渲染一致
  const available = regionMain - Math.max(0, list.length - 1) * PANEL_SPLIT_SIZE
  if (available <= 0 || startA <= 0 || startB <= 0) return

  const totalWeight = list.reduce((sum, p) => sum + layout.panelWeight[p], 0)
  if (totalWeight <= 0) return

  resizeCtx = {
    region,
    a,
    b,
    startPos: horizontal ? event.clientX : event.clientY,
    startA,
    startB,
    totalWeight,
    available,
    horizontal
  }
  document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
  window.addEventListener('pointermove', onPanelResizeMove)
  window.addEventListener('pointerup', onPanelResizeEnd)
}

function onPanelResizeMove(event: PointerEvent): void {
  const ctx = resizeCtx
  if (!ctx) return
  const pos = ctx.horizontal ? event.clientX : event.clientY
  const delta = pos - ctx.startPos
  const pairTotal = ctx.startA + ctx.startB
  // 两个板块尺寸守恒：a 变多少，b 就反向变多少；各自不小于最小尺寸
  const targetA = clampSize(ctx.startA + delta, ctx.startA, PANEL_MIN_MAIN, pairTotal - PANEL_MIN_MAIN)
  const targetB = pairTotal - targetA
  // 像素 → 权重：权重和保持不变，因此同区域其余板块尺寸不受影响
  layout.panelWeight[ctx.a] = clampSize(
    (ctx.totalWeight * targetA) / ctx.available,
    layout.panelWeight[ctx.a],
    PANEL_WEIGHT_MIN,
    PANEL_WEIGHT_MAX
  )
  layout.panelWeight[ctx.b] = clampSize(
    (ctx.totalWeight * targetB) / ctx.available,
    layout.panelWeight[ctx.b],
    PANEL_WEIGHT_MIN,
    PANEL_WEIGHT_MAX
  )
  persist()
}

function onPanelResizeEnd(): void {
  if (!resizeCtx) return
  stopPanelResize()
  persist()
}

/** 结束板块尺寸拖拽（退出编辑模式时也要调用，避免监听器残留） */
function stopPanelResize(): void {
  resizeCtx = null
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onPanelResizeMove)
  window.removeEventListener('pointerup', onPanelResizeEnd)
}
