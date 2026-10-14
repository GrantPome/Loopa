<script setup lang="ts">
/**
 * 应用外壳：可编排的三区域布局
 * - 左栏 / 中央主区 / 底部栏 三个区域，各自按顺序排列功能板块
 * - 设置页可进入「布局编辑模式」，拖拽板块排序或跨区域互换
 * - 区域尺寸（左栏宽、底部高）通过拖拽分隔条调整
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TopToolbar from './components/TopToolbar.vue'
import DockRegion from './components/DockRegion.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import InstrumentDialog from './components/InstrumentDialog.vue'
import {
  layout,
  layoutUi,
  resetLayout,
  setBottomHeight,
  setEditMode,
  setLeftWidth
} from './core/layout'
import {
  activeTrack,
  clearNoteSelection,
  deleteSelectedNotes,
  ensureAudio,
  nudgeSelectedVelocity,
  redo,
  removeClip,
  state,
  togglePlay,
  transposeSelectedNotes,
  undo
} from './core/store'

const historyOpen = ref(false)

/**
 * WebAudio 规则：音频上下文必须在用户手势之后初始化，
 * 这里监听首次点击，页面加载时绝不自动发声。
 */
function onFirstGesture(): void {
  void ensureAudio()
}

function onKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  // 在输入框里打字时不触发快捷键
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return

  // 编辑模式优先：Esc 先退出布局编辑
  if (event.key === 'Escape' && layoutUi.editMode) {
    event.preventDefault()
    setEditMode(false)
    return
  }

  // 布局编辑模式下锁定其余全部功能快捷键（撤销/重做、播放、删除、移调等），只能拖拽排序
  if (layoutUi.editMode) return

  // 有弹窗打开时，除 Esc 外不响应主界面快捷键，避免在弹窗里误触发播放/删除等操作
  if (state.instrumentOpen || state.settingsOpen || historyOpen.value) {
    if (event.key === 'Escape') {
      historyOpen.value = false
      clearNoteSelection()
    }
    return
  }

  // 撤销 / 重做：Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y（Mac 上对应 ⌘）
  const mod = event.ctrlKey || event.metaKey
  if (mod && (event.key === 'z' || event.key === 'Z')) {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (mod && (event.key === 'y' || event.key === 'Y')) {
    event.preventDefault()
    redo()
    return
  }

  if (event.code === 'Space') {
    event.preventDefault()
    void togglePlay()
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    // 音频轨上删除的是选中的波形片段，MIDI 轨上删除的是选中的音符
    const track = activeTrack()
    if (track?.kind === 'audio' && state.selectedClipId) removeClip(track.id, state.selectedClipId)
    else deleteSelectedNotes()
  } else if (event.key === 'Escape') {
    historyOpen.value = false
    clearNoteSelection()
  } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && state.selectedNoteIds.length > 0) {
    // ↑ / ↓ 调力度，Shift + ↑ / ↓ 移调（专业 DAW 常见的音符微调方式）
    event.preventDefault()
    const dir = event.key === 'ArrowUp' ? 1 : -1
    if (event.shiftKey) transposeSelectedNotes(dir)
    else nudgeSelectedVelocity(dir * 0.047)
  }
}

// ---------------------------------------------------------------- 区域尺寸拖拽

/** 左栏宽度拖拽 */
function startResizeLeft(event: PointerEvent): void {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = layout.leftWidth
  const move = (e: PointerEvent): void => setLeftWidth(startWidth + (e.clientX - startX))
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/** 底部栏高度拖拽（向上拖为增高） */
function startResizeBottom(event: PointerEvent): void {
  event.preventDefault()
  const startY = event.clientY
  const startHeight = layout.bottomHeight
  const move = (e: PointerEvent): void => setBottomHeight(startHeight + (startY - e.clientY))
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

onMounted(() => {
  window.addEventListener('pointerdown', onFirstGesture)
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onFirstGesture)
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="app" :class="{ editing: layoutUi.editMode }">
    <TopToolbar @open-history="historyOpen = true" />

    <!-- 布局编辑模式提示条 -->
    <div v-if="layoutUi.editMode" class="edit-banner">
      <span class="dot" />
      <strong>布局编辑模式</strong>
      <span class="hint">功能已锁定；可拖拽板块排序、拖动板块之间的分隔条调整宽高</span>
      <span class="spacer" />
      <button @click="resetLayout">恢复默认</button>
      <button class="primary" @click="setEditMode(false)">完成</button>
    </div>

    <div class="app-body">
      <div class="main-row">
        <DockRegion region="left" />
        <div v-if="layout.left.length" class="splitter splitter-v" title="拖动调整左栏宽度" @pointerdown="startResizeLeft" />
        <DockRegion region="center" />
      </div>

      <div v-if="layout.bottom.length" class="splitter splitter-h" title="拖动调整底部栏高度" @pointerdown="startResizeBottom" />
      <DockRegion region="bottom" />
    </div>

    <ProjectDialog :open="historyOpen" @close="historyOpen = false" />
    <Transition name="mask-fade">
      <SettingsDialog v-if="state.settingsOpen" />
    </Transition>
    <Transition name="mask-fade">
      <InstrumentDialog v-if="state.instrumentOpen" />
    </Transition>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
}

.app-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}

.main-row {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

/* 区域分隔条 */
.splitter {
  flex: 0 0 6px;
  position: relative;
  z-index: 3;
}

.splitter-v {
  cursor: col-resize;
}

.splitter-h {
  cursor: row-resize;
}

.splitter-v::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: var(--line);
  transition: background 0.15s ease;
}

.splitter-h::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 2px;
  height: 1px;
  background: var(--line);
  transition: background 0.15s ease;
}

.splitter:hover::after {
  background: var(--accent);
}

/* 编辑模式提示条 */
.edit-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--accent-soft);
  border-bottom: 1px solid var(--accent);
  color: var(--text);
}

.edit-banner .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}

.edit-banner .hint {
  font-size: 12px;
  color: var(--text-dim);
}

.edit-banner .spacer {
  flex: 1;
}
</style>
