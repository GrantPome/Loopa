/**
 * 布局编排（可任意嵌套的分割树）
 *
 * 设计：
 * - 整个界面是一棵布局树：叶子是功能板块，分支是「分割容器」（横向并排 / 纵向堆叠）。
 * - 任意板块都能插入到另一个板块的上 / 下 / 左 / 右（插入语义，不是交换）：
 *   · 目标板块所在容器的方向与插入方向一致 → 作为兄弟节点插入，并平分目标板块的占比；
 *   · 方向不一致（或目标就是根节点）→ 把目标板块包进一个同方向的新容器，两者各占一半。
 * - 子节点尺寸以「占比」形式挂在分割容器上，窗口缩放时等比自适应，不会出现空隙或溢出。
 * - 布局配置持久化到 localStorage；归一化保证每个板块恰好出现一次、未知板块剔除、缺失板块补回，
 *   旧版「三区域」数据会在加载时按当前窗口尺寸换算成布局树。
 * - 编辑模式（从设置页进入）下板块顶部出现拖拽标题栏，拖动时目标板块的对应半边高亮作为插入预览。
 *
 * 拖拽采用 Pointer Events 实现（同时兼容鼠标与触屏），命中判定直接读取板块 DOM 矩形，
 * 因此嵌套层级再深也不需要额外维护 ref。
 */
import { reactive } from 'vue'
import type { DropZone, LayoutConfig, LayoutNode, PanelId, PanelNode, SplitNode } from '@/types'

/** 板块显示名（编辑模式标题栏、拖拽提示使用） */
export const PANEL_LABELS: Record<PanelId, string> = {
  tracks: '轨道',
  fx: '效果器',
  editor: '编辑区',
  inspector: '音符检查器',
  keyboard: '虚拟键盘',
  master: '总输出'
}

/** 全部板块（归一化兜底用，顺序即默认出现顺序） */
const ALL_PANELS: PanelId[] = ['tracks', 'fx', 'editor', 'inspector', 'keyboard', 'master']

/** 板块之间的分隔条宽度（px），与 DockNode 中样式保持一致 */
export const PANEL_SPLIT_SIZE = 6

/** 板块主轴最小尺寸（px），避免被拖到不可见 */
export const PANEL_MIN_MAIN = 56

/** 占比下限：防止某个节点被拖成 0 后再也拖不回来 */
const RATIO_MIN = 0.02

const LAYOUT_KEY = 'muisc-editor:v1:layout'

// ---------------------------------------------------------------- 树构建工具

let splitSeq = 0

/** 分割容器的稳定标识：列表渲染时用它复用组件实例 */
function nextSplitKey(): string {
  splitSeq += 1
  return `s${splitSeq}`
}

function panel(id: PanelId): PanelNode {
  return { type: 'panel', id }
}

/** 新建分割容器；不传 sizes 时等分 */
function split(dir: 'row' | 'column', children: LayoutNode[], sizes?: number[]): SplitNode {
  return {
    type: 'split',
    key: nextSplitKey(),
    dir,
    children,
    sizes: sizes ?? children.map(() => (children.length > 0 ? 1 / children.length : 1))
  }
}

/** 占比归一化：总和为 1；数据异常时退化为等分 */
function normalizeSizes(node: SplitNode): void {
  const list = node.children.map((_, i) => {
    const v = node.sizes[i]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
  })
  const total = list.reduce((sum, v) => sum + v, 0)
  node.sizes =
    total > 0 ? list.map((v) => v / total) : node.children.map(() => 1 / node.children.length)
}

/**
 * 折叠与合并（原地修改并返回节点，返回 null 表示该分支已被清空）：
 * - 清空的容器直接删除；
 * - 只剩一个子节点时用子节点顶替容器，避免无意义的嵌套；
 * - 子容器与父容器方向相同时把子节点提升到父容器（占比相乘），保持树尽可能扁平。
 */
function collapseNode(node: LayoutNode): LayoutNode | null {
  if (node.type === 'panel') return node

  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const kept = collapseNode(child)
    if (!kept) return
    const size = node.sizes[i] > 0 ? node.sizes[i] : 1
    if (kept.type === 'split' && kept.dir === node.dir) {
      kept.children.forEach((grandChild, j) => {
        children.push(grandChild)
        sizes.push(size * (kept.sizes[j] ?? 0))
      })
    } else {
      children.push(kept)
      sizes.push(size)
    }
  })

  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  node.children = children
  node.sizes = sizes
  normalizeSizes(node)
  return node
}

/** 查找板块所在的父容器、下标与节点本身（parent 为 null 表示它就是根） */
interface PanelLocation {
  parent: SplitNode | null
  index: number
  node: PanelNode
}

function findPanelLocation(root: LayoutNode, id: PanelId): PanelLocation | null {
  const walk = (node: LayoutNode, parent: SplitNode | null, index: number): PanelLocation | null => {
    if (node.type === 'panel') return node.id === id ? { parent, index, node } : null
    for (let i = 0; i < node.children.length; i += 1) {
      const found = walk(node.children[i], node, i)
      if (found) return found
    }
    return null
  }
  return walk(root, null, 0)
}

// ---------------------------------------------------------------- 默认布局

/** 默认布局树：中段「左栏（轨道 / 效果器 / 音符检查器） | 编辑区」，底部「虚拟键盘 | 总输出」 */
function defaultRoot(): SplitNode {
  return split(
    'column',
    [
      split(
        'row',
        [split('column', [panel('tracks'), panel('fx'), panel('inspector')]), panel('editor')],
        [0.21, 0.79]
      ),
      split('row', [panel('keyboard'), panel('master')], [0.75, 0.25])
    ],
    [0.82, 0.18]
  )
}

/** 默认布局（与旧版三栏观感基本一致） */
export function defaultLayout(): LayoutConfig {
  return { root: defaultRoot() }
}

// ---------------------------------------------------------------- 归一化与旧数据换算

/** 旧版（三区域）布局数据 */
type LegacyLayout = {
  left?: PanelId[]
  center?: PanelId[]
  bottom?: PanelId[]
  leftWidth?: number
  bottomHeight?: number
  panelWeight?: Partial<Record<PanelId, number>>
}

/** 是否为旧版三区域数据（用于加载时自动换算，避免用户手动迁移） */
function isLegacy(raw: Record<string, unknown>): boolean {
  return Array.isArray(raw.left) || Array.isArray(raw.center) || Array.isArray(raw.bottom)
}

/**
 * 清洗布局树：剔除未知板块与重复板块（每个板块最多出现一次），
 * 兼容缺 type 字段或 sizes 长度不一致的脏数据。
 */
function sanitize(raw: unknown, seen: Set<PanelId>): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null
  const node = raw as Partial<SplitNode> & { id?: unknown }
  if (node.type !== 'split' || !Array.isArray(node.children)) {
    const id = node.id as PanelId
    if (typeof id !== 'string' || !ALL_PANELS.includes(id) || seen.has(id)) return null
    seen.add(id)
    return panel(id)
  }

  const dir: 'row' | 'column' = node.dir === 'row' ? 'row' : 'column'
  const rawSizes = Array.isArray(node.sizes) ? node.sizes : []
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, i) => {
    const kept = sanitize(child, seen)
    if (!kept) return
    const s = Number(rawSizes[i])
    children.push(kept)
    sizes.push(Number.isFinite(s) && s > 0 ? s : 1)
  })
  if (children.length === 0) return null

  const result = split(dir, children, sizes)
  if (typeof node.key === 'string' && node.key) result.key = node.key
  return result
}

/** 归一化新格式数据：清洗 + 折叠，返回可用的布局树 */
function normalizeTree(raw: Record<string, unknown>): LayoutNode | null {
  const seen = new Set<PanelId>()
  const candidate = 'root' in raw ? raw.root : raw
  const cleaned = sanitize(candidate, seen)
  return cleaned ? collapseNode(cleaned) : null
}

/**
 * 旧版三区域数据 → 布局树：
 * 区域内的板块顺序沿用原数组，尺寸用原来的权重 / 像素值按当前窗口换算成占比。
 */
function legacyToTree(raw: LegacyLayout): LayoutNode | null {
  const ids = (value: unknown): PanelId[] =>
    Array.isArray(value) ? (value as PanelId[]).filter((id) => ALL_PANELS.includes(id)) : []
  const weightOf = (id: PanelId): number => {
    const w = raw.panelWeight?.[id]
    return typeof w === 'number' && w > 0 ? w : 1
  }
  const stack = (list: PanelId[], dir: 'row' | 'column'): SplitNode | null =>
    list.length === 0 ? null : split(dir, list.map(panel), list.map(weightOf))

  const left = stack(ids(raw.left), 'column')
  const center = stack(ids(raw.center), 'column')
  const bottom = stack(ids(raw.bottom), 'row')

  const viewW = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1280
  const viewH = typeof window !== 'undefined' && window.innerHeight > 0 ? window.innerHeight : 800
  const leftWidth = raw.leftWidth && raw.leftWidth > 0 ? raw.leftWidth : viewW * 0.22
  const bottomHeight = raw.bottomHeight && raw.bottomHeight > 0 ? raw.bottomHeight : viewH * 0.18

  // 中段一行：左栏（原固定像素）| 中央主区（占剩余空间）
  const rowChildren: LayoutNode[] = []
  const rowSizes: number[] = []
  if (left) {
    rowChildren.push(left)
    rowSizes.push(leftWidth)
  }
  if (center) {
    rowChildren.push(center)
    rowSizes.push(Math.max(240, viewW - leftWidth - PANEL_SPLIT_SIZE))
  }
  const mainRow = rowChildren.length > 0 ? split('row', rowChildren, rowSizes) : null

  // 底部一行：原固定高度向上换算
  const colChildren: LayoutNode[] = []
  const colSizes: number[] = []
  if (mainRow) {
    colChildren.push(mainRow)
    colSizes.push(Math.max(160, viewH - bottomHeight - PANEL_SPLIT_SIZE))
  }
  if (bottom) {
    colChildren.push(bottom)
    colSizes.push(bottomHeight)
  }
  if (colChildren.length === 0) return null
  return collapseNode(split('column', colChildren, colSizes))
}

// ---------------------------------------------------------------- 读写与持久化

function loadLayout(): LayoutConfig {
  try {
    const text = localStorage.getItem(LAYOUT_KEY)
    if (!text) return { root: defaultRoot() }
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object') return { root: defaultRoot() }
    const record = raw as Record<string, unknown>
    const tree = isLegacy(record) ? legacyToTree(record as LegacyLayout) : normalizeTree(record)
    return { root: tree ?? defaultRoot() }
  } catch {
    return { root: defaultRoot() }
  }
}

/** 当前布局（响应式布局树） */
export const layout = reactive<LayoutConfig>(loadLayout())

/** 编辑模式与拖拽过程中的临时状态（不持久化） */
export const layoutUi = reactive({
  editMode: false,
  /** 正在拖拽的板块 */
  dragPanel: null as PanelId | null,
  /** 当前插入目标板块 */
  dropPanel: null as PanelId | null,
  /** 插入方位 */
  dropZone: null as DropZone | null,
  /** 插入预览矩形（视口坐标）：高亮目标板块的对应半边 */
  dropRect: null as { left: number; top: number; width: number; height: number } | null
})

function persist(): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ root: layout.root }))
  } catch {
    // 忽略存储配额异常，布局丢失不影响功能
  }
}

/**
 * 补回缺失板块：按默认顺序找到就近的已存在板块作锚点，插到它旁边。
 * 这样即使 localStorage 数据被手工改坏（板块被删掉），界面也不会缺板块。
 */
function fillMissingPanels(): void {
  const present = new Set<PanelId>()
  const collect = (node: LayoutNode): void => {
    if (node.type === 'panel') present.add(node.id)
    else node.children.forEach(collect)
  }
  collect(layout.root)

  let changed = false
  for (const id of ALL_PANELS) {
    if (present.has(id)) continue
    const at = ALL_PANELS.indexOf(id)
    let anchor: PanelId | null = null
    for (let i = at - 1; i >= 0 && !anchor; i -= 1) if (present.has(ALL_PANELS[i])) anchor = ALL_PANELS[i]
    for (let i = at + 1; i < ALL_PANELS.length && !anchor; i += 1) {
      if (present.has(ALL_PANELS[i])) anchor = ALL_PANELS[i]
    }
    if (!anchor) continue
    insertAfter(anchor, id)
    present.add(id)
    changed = true
  }
  if (changed) persist()
}

// 载入后立即补全缺失板块（模块初始化时执行一次）
fillMissingPanels()

// ---------------------------------------------------------------- 插入 / 移除

/**
 * 在锚点板块之后插入一个兄弟板块（方向跟随父容器；锚点就是根时新建纵向容器）。
 * 主要用于补回缺失板块，也可作为「向右 / 向下插入」的简化入口。
 */
function insertAfter(anchor: PanelId, id: PanelId): void {
  const at = findPanelLocation(layout.root, anchor)
  if (!at) {
    layout.root = appendToRoot(layout.root, panel(id))
    return
  }
  if (!at.parent) {
    layout.root = split('column', [at.node, panel(id)], [0.6, 0.4])
    return
  }
  const share = at.parent.sizes[at.index] / 2
  at.parent.sizes[at.index] = share
  at.parent.children.splice(at.index + 1, 0, panel(id))
  at.parent.sizes.splice(at.index + 1, 0, share)
}

/** 把节点挂到根容器末尾（根是单板块时新建纵向容器） */
function appendToRoot(root: LayoutNode, node: LayoutNode): LayoutNode {
  if (root.type === 'panel') return split('column', [root, node], [0.6, 0.4])
  const avg =
    root.sizes.length > 0 ? root.sizes.reduce((sum, v) => sum + v, 0) / root.sizes.length : 1
  root.children.push(node)
  root.sizes.push(avg)
  return root
}

/** 从树上摘下某个板块（其余兄弟按比例吸收空出的占比，并折叠多余容器） */
function removePanel(id: PanelId): void {
  const at = findPanelLocation(layout.root, id)
  if (!at || !at.parent) return
  at.parent.children.splice(at.index, 1)
  at.parent.sizes.splice(at.index, 1)
  layout.root = collapseNode(layout.root) ?? layout.root
}

/**
 * 把板块插入到目标板块的指定方位（核心「插入」逻辑）。
 * @param id 被拖拽的板块
 * @param target 目标板块
 * @param zone 插入到目标的哪一侧
 */
export function insertPanel(id: PanelId, target: PanelId, zone: DropZone): void {
  if (id === target) return

  // 先把自己从原位置摘下，再重新插入，保证「移动 + 插入」两个语义合并为一步
  removePanel(id)
  const at = findPanelLocation(layout.root, target)
  if (!at) {
    layout.root = appendToRoot(layout.root, panel(id))
    persist()
    return
  }

  const horizontal = zone === 'left' || zone === 'right'
  const dir: 'row' | 'column' = horizontal ? 'row' : 'column'
  const after = zone === 'right' || zone === 'bottom'

  if (at.parent && at.parent.dir === dir) {
    // 方向一致：作为兄弟插入，平分目标板块的占比
    const share = at.parent.sizes[at.index] / 2
    at.parent.sizes[at.index] = share
    const pos = after ? at.index + 1 : at.index
    at.parent.children.splice(pos, 0, panel(id))
    at.parent.sizes.splice(pos, 0, share)
  } else {
    // 方向不一致：把目标板块包进一个同方向的新容器，顶替它原来的位置
    const wrapper = split(dir, after ? [at.node, panel(id)] : [panel(id), at.node], [0.5, 0.5])
    if (at.parent) at.parent.children[at.index] = wrapper
    else layout.root = wrapper
  }

  const collapsed = collapseNode(layout.root)
  if (collapsed) layout.root = collapsed
  persist()
}

// ---------------------------------------------------------------- 编辑模式

/** 进入 / 退出布局编辑模式 */
export function setEditMode(on: boolean): void {
  layoutUi.editMode = on
  if (!on) {
    endDrag()
    stopSplitResize()
  }
}

/** 恢复默认布局 */
export function resetLayout(): void {
  layout.root = defaultRoot()
  persist()
}

// ---------------------------------------------------------------- 拖拽插入

/** 指针偏向矩形的哪条边（取最近的一条，即插到哪一侧） */
function nearestZone(rect: DOMRect, x: number, y: number): DropZone {
  const left = x - rect.left
  const right = rect.right - x
  const top = y - rect.top
  const bottom = rect.bottom - y
  const min = Math.min(left, right, top, bottom)
  if (min === left) return 'left'
  if (min === right) return 'right'
  if (min === top) return 'top'
  return 'bottom'
}

/** 插入预览矩形：目标板块在该方向上的半边 */
function halfRect(rect: DOMRect, zone: DropZone): { left: number; top: number; width: number; height: number } {
  const halfW = rect.width / 2
  const halfH = rect.height / 2
  if (zone === 'left') return { left: rect.left, top: rect.top, width: halfW, height: rect.height }
  if (zone === 'right') return { left: rect.left + halfW, top: rect.top, width: halfW, height: rect.height }
  if (zone === 'top') return { left: rect.left, top: rect.top, width: rect.width, height: halfH }
  return { left: rect.left, top: rect.top + halfH, width: rect.width, height: halfH }
}

/** 可作为落点的板块（排除正在拖拽的那个） */
function panelTargets(): { id: PanelId; rect: DOMRect }[] {
  const els = Array.from(document.querySelectorAll<HTMLElement>('.dock-panel[data-panel]'))
  const out: { id: PanelId; rect: DOMRect }[] = []
  for (const el of els) {
    const id = el.dataset.panel as PanelId | undefined
    if (!id || id === layoutUi.dragPanel) continue
    out.push({ id, rect: el.getBoundingClientRect() })
  }
  return out
}

function setDrop(panel: PanelId, zone: DropZone, rect: DOMRect): void {
  layoutUi.dropPanel = panel
  layoutUi.dropZone = zone
  layoutUi.dropRect = halfRect(rect, zone)
}

function clearDrop(): void {
  layoutUi.dropPanel = null
  layoutUi.dropZone = null
  layoutUi.dropRect = null
}

/** 根据指针位置更新插入目标：优先命中板块本体，落在缝隙里时取最近的板块 */
function updateDropTarget(x: number, y: number): void {
  const targets = panelTargets()

  for (const target of targets) {
    const r = target.rect
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    setDrop(target.id, nearestZone(r, x, y), r)
    return
  }

  let nearest: { id: PanelId; rect: DOMRect; dist: number } | null = null
  for (const target of targets) {
    const r = target.rect
    const dx = Math.max(r.left - x, 0, x - r.right)
    const dy = Math.max(r.top - y, 0, y - r.bottom)
    const dist = Math.hypot(dx, dy)
    if (!nearest || dist < nearest.dist) nearest = { id: target.id, rect: r, dist }
  }
  if (nearest && nearest.dist <= 40) {
    const cx = Math.min(Math.max(x, nearest.rect.left), nearest.rect.right)
    const cy = Math.min(Math.max(y, nearest.rect.top), nearest.rect.bottom)
    setDrop(nearest.id, nearestZone(nearest.rect, cx, cy), nearest.rect)
    return
  }
  clearDrop()
}

let dragging = false

function onDragMove(event: PointerEvent): void {
  if (!dragging) return
  updateDropTarget(event.clientX, event.clientY)
}

function onDragEnd(): void {
  const panel = layoutUi.dragPanel
  const target = layoutUi.dropPanel
  const zone = layoutUi.dropZone
  if (panel && target && zone) insertPanel(panel, target, zone)
  endDrag()
}

function onDragKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') endDrag()
}

function endDrag(): void {
  dragging = false
  layoutUi.dragPanel = null
  clearDrop()
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('keydown', onDragKey)
}

/** 从板块标题栏（或整块遮罩）开始拖拽 */
export function startPanelDrag(event: PointerEvent, panel: PanelId): void {
  if (!layoutUi.editMode) return
  event.preventDefault()
  layoutUi.dragPanel = panel
  clearDrop()
  dragging = true
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('keydown', onDragKey)
  updateDropTarget(event.clientX, event.clientY)
}

// ---------------------------------------------------------------- 尺寸调整
// 相邻两个子板块之间渲染一条分隔条，拖拽它改变两者的占比。
// 占比挂在父容器上，父容器的占比总和保持不变，因此同级其它板块尺寸不受影响，
// 窗口缩放时各板块按占比等比自适应。

interface ResizeContext {
  node: SplitNode
  index: number
  /** 指针起始坐标（主轴方向） */
  startPos: number
  /** 相邻两个子节点的起始像素尺寸 */
  startA: number
  startB: number
  /** 容器内占比总和（保持不变） */
  total: number
  /** 容器主轴可用长度（已扣除分隔条占位） */
  available: number
  horizontal: boolean
}

let resizeCtx: ResizeContext | null = null

/** 开始拖拽某容器内相邻子节点之间的分隔条 */
export function startSplitResize(event: PointerEvent, node: SplitNode, index: number): void {
  if (!layoutUi.editMode) return
  event.preventDefault()
  const splitter = event.currentTarget as HTMLElement | null
  const prev = splitter?.previousElementSibling as HTMLElement | null
  const next = splitter?.nextElementSibling as HTMLElement | null
  const container = splitter?.parentElement ?? null
  if (!prev || !next || !container) return

  const horizontal = node.dir === 'row'
  const rectA = prev.getBoundingClientRect()
  const rectB = next.getBoundingClientRect()
  const startA = horizontal ? rectA.width : rectA.height
  const startB = horizontal ? rectB.width : rectB.height
  const containerMain = horizontal ? container.clientWidth : container.clientHeight
  // 扣除分隔条占位，使占比换算出的像素尺寸与实际渲染一致
  const available = containerMain - Math.max(0, node.children.length - 1) * PANEL_SPLIT_SIZE
  if (available <= 0 || startA <= 0 || startB <= 0) return

  const total = node.sizes.reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0)
  if (total <= 0) return

  resizeCtx = {
    node,
    index,
    startPos: horizontal ? event.clientX : event.clientY,
    startA,
    startB,
    total,
    available,
    horizontal
  }
  document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
  window.addEventListener('pointermove', onSplitResizeMove)
  window.addEventListener('pointerup', onSplitResizeEnd)
}

function onSplitResizeMove(event: PointerEvent): void {
  const ctx = resizeCtx
  if (!ctx) return
  const pos = ctx.horizontal ? event.clientX : event.clientY
  const pairTotal = ctx.startA + ctx.startB
  // 两个子节点尺寸守恒：A 变多少 B 就反向变多少，各自不小于最小尺寸
  const minMain = Math.min(PANEL_MIN_MAIN, pairTotal / 2)
  const targetA = Math.min(Math.max(ctx.startA + (pos - ctx.startPos), minMain), pairTotal - minMain)
  const ratioA = ctx.total * (targetA / ctx.available)
  const ratioB = ctx.total * ((pairTotal - targetA) / ctx.available)
  // 再兜一层占比下限，保证拖到极小也还能拖回来
  const lo = ctx.total * RATIO_MIN
  const hi = ctx.total * (1 - RATIO_MIN)
  ctx.node.sizes[ctx.index] = Math.min(Math.max(ratioA, lo), hi)
  ctx.node.sizes[ctx.index + 1] = Math.min(Math.max(ratioB, lo), hi)
  persist()
}

function onSplitResizeEnd(): void {
  stopSplitResize()
  persist()
}

/** 结束尺寸拖拽（退出编辑模式时也要调用，避免监听器残留） */
function stopSplitResize(): void {
  resizeCtx = null
  document.body.style.cursor = ''
  window.removeEventListener('pointermove', onSplitResizeMove)
  window.removeEventListener('pointerup', onSplitResizeEnd)
}
