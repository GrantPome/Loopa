/**
 * 撤销 / 重做历史
 *
 * 采用「工程快照」方案：每次改动前后各留一份工程整体状态，
 * 实现简单，且天然覆盖音符、混音、效果器、音频片段等所有编辑动作。
 * 连续型操作（拖动推子、拖拽音符）通过 coalesceKey 合并为一步，
 * 避免一次拖拽产生几十条历史记录。
 *
 * 说明：音频片段的 PCM 采样存在 IndexedDB 中，不进入快照；
 * 因此撤销「删除音频片段」时能恢复片段元信息与波形，但不会重复拷贝采样数据。
 */
import { reactive } from 'vue'
import type { Project } from '@/types'

/** 历史栈最大深度（超出后丢弃最早的记录） */
const MAX_DEPTH = 60
/** 同一合并键在该时间窗内的连续提交视为一步 */
const COALESCE_MS = 900

interface HistoryEntry {
  label: string
  snapshot: Project
}

let undoStack: HistoryEntry[] = []
let redoStack: HistoryEntry[] = []
/** 上一个历史基点的工程快照，也就是「撤销」会回到的状态 */
let baseline: Project | null = null
/** 上一次提交的合并键与时间，用于判断是否合并 */
let lastKey = ''
let lastAt = 0

/** 供界面绑定的历史状态（按钮可用性、提示文案） */
export const historyUi = reactive({
  canUndo: false,
  canRedo: false,
  undoLabel: '',
  redoLabel: ''
})

/** 深拷贝工程（剥离 Vue 响应式代理，得到纯数据快照） */
function clone(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project
}

function syncUi(): void {
  historyUi.canUndo = undoStack.length > 0
  historyUi.canRedo = redoStack.length > 0
  historyUi.undoLabel = undoStack[undoStack.length - 1]?.label ?? ''
  historyUi.redoLabel = redoStack[redoStack.length - 1]?.label ?? ''
}

/** 初始化 / 重置历史（新建、加载、导入工程时调用） */
export function resetHistory(project: Project): void {
  undoStack = []
  redoStack = []
  baseline = clone(project)
  lastKey = ''
  lastAt = 0
  syncUi()
}

/**
 * 记录一次改动。应在改动「完成之后」调用，此时 project 已是改动后的状态。
 * @param project 当前工程
 * @param label 改动描述，用于界面提示（如「删除音符」）
 * @param coalesceKey 合并键：非空且与上次相同、且间隔小于窗口时，合并为同一步
 */
export function recordChange(project: Project, label = '编辑', coalesceKey = ''): void {
  const now = performance.now()
  const merged = coalesceKey !== '' && coalesceKey === lastKey && now - lastAt < COALESCE_MS
  if (!merged) {
    if (baseline) {
      undoStack.push({ label, snapshot: baseline })
      if (undoStack.length > MAX_DEPTH) undoStack.shift()
    }
    redoStack = []
  }
  lastKey = coalesceKey
  lastAt = now
  // 无论是否合并，都把基点推进到当前状态，保证下一步撤销的落点正确
  baseline = clone(project)
  syncUi()
}

/**
 * 撤销：返回应当恢复的工程快照，无历史时返回 null。
 * @param current 当前工程，会被压入重做栈
 */
export function undo(current: Project): Project | null {
  const entry = undoStack.pop()
  if (!entry) return null
  redoStack.push({ label: entry.label, snapshot: clone(current) })
  baseline = clone(entry.snapshot)
  lastKey = ''
  lastAt = 0
  syncUi()
  return entry.snapshot
}

/** 重做：返回应当恢复的工程快照 */
export function redo(current: Project): Project | null {
  const entry = redoStack.pop()
  if (!entry) return null
  undoStack.push({ label: entry.label, snapshot: clone(current) })
  baseline = clone(entry.snapshot)
  lastKey = ''
  lastAt = 0
  syncUi()
  return entry.snapshot
}
