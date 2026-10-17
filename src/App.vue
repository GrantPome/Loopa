<script setup lang="ts">
/**
 * 应用外壳：可任意编排的布局树
 * - 界面由 src/core/layout.ts 中的布局树（板块 + 分割容器）递归渲染
 * - 设置页可进入「布局编辑模式」，把任意板块拖到其它板块的上 / 下 / 左 / 右插入
 * - 板块之间的分隔条可拖拽调整占比，窗口缩放时按占比等比自适应
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import TopToolbar from './components/TopToolbar.vue'
import DockNode from './components/DockNode.vue'
import HomePage from './components/HomePage.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import InstrumentDialog from './components/InstrumentDialog.vue'
import ExportDialog from './components/ExportDialog.vue'
import { layout, layoutUi, resetLayout, setEditMode } from '@/core/layout'
import {
  activeTrack,
  addMarker,
  clearNoteSelection,
  deleteSelectedNotes,
  endRecording,
  ensureAudio,
  handleMidiNoteOff,
  handleMidiNoteOn,
  nudgeSelectedVelocity,
  pause,
  redo,
  removeClip,
  state,
  togglePlay,
  transposeSelectedNotes,
  undo
} from '@/core/store'
import { setMidiHandlers } from '@/core/midiInput'

/** 主页（欢迎页）开关：首次打开站点时先展示主页 */
const homeOpen = ref(true)
const historyOpen = ref(false)
/** 导出音频对话框开关 */
const exportOpen = ref(false)

/** 主页「历史工程」：打开历史工程对话框 */
function onOpenHistory(): void {
  historyOpen.value = true
}

/**
 * 从编辑器返回主页。
 * 必须先停止走带：Tone.Transport 与编辑器界面无关，仅切换视图不会停声，
 * 否则主页上音乐会继续播放，只能再进编辑器手动暂停。
 * 录音中则先结束录音落盘；普通播放直接暂停并保留播放头位置。
 */
async function onOpenHome(): Promise<void> {
  if (state.recording) await endRecording()
  else pause()
  homeOpen.value = true
}

/** 插入预览（视口坐标，position: fixed 直接使用） */
const dropPreviewStyle = computed(() => {
  const rect = layoutUi.dropRect
  if (!rect) return undefined
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
})

/**
 * WebAudio 规则：音频上下文必须在用户手势之后初始化，
 * 这里监听首次点击，页面加载时绝不自动发声。
 */
function onFirstGesture(): void {
  void ensureAudio()
}

function onKeyDown(event: KeyboardEvent): void {
  // 主页上不响应编辑器快捷键
  if (homeOpen.value) return

  const target = event.target as HTMLElement | null
  // 在输入框里打字时不触发快捷键
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return

  // 编辑模式优先：Esc 先取消拖拽 / 退出布局编辑
  if (event.key === 'Escape' && layoutUi.editMode) {
    event.preventDefault()
    if (layoutUi.dragPanel) return // 拖拽中的 Esc 由拖拽逻辑自身处理
    setEditMode(false)
    return
  }

  // 布局编辑模式下锁定其余全部功能快捷键（撤销/重做、播放、删除、移调等），只能拖拽编排
  if (layoutUi.editMode) return

  // 有弹窗打开时，除 Esc 外不响应主界面快捷键，避免在弹窗里误触发播放/删除等操作
  if (state.instrumentOpen || state.settingsOpen || historyOpen.value || exportOpen.value) {
    if (event.key === 'Escape') {
      historyOpen.value = false
      exportOpen.value = false
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
  } else if (event.key === 'm' || event.key === 'M') {
    // M：在播放头位置打一个标记点（卡点常用：空格播放、听到重音按 M）
    event.preventDefault()
    addMarker()
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

onMounted(() => {
  window.addEventListener('pointerdown', onFirstGesture)
  window.addEventListener('keydown', onKeyDown)
  // MIDI 硬件音符 → 试听 + 录制（是否录制取决于顶栏「♪」待命状态）
  setMidiHandlers(handleMidiNoteOn, handleMidiNoteOff)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onFirstGesture)
  window.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div class="app" :class="{ editing: layoutUi.editMode }">
    <!-- 主页（欢迎页）：进入编辑器后不再展示 -->
    <HomePage
      v-if="homeOpen"
      @enter="homeOpen = false"
      @history="onOpenHistory"
    />

    <template v-else>
      <TopToolbar
        @open-history="historyOpen = true"
        @open-home="onOpenHome"
        @open-export="exportOpen = true"
      />

      <!-- 布局编辑模式提示条 -->
      <div v-if="layoutUi.editMode" class="edit-banner">
        <span class="dot" />
        <strong>布局编辑模式</strong>
        <span class="hint">功能已锁定；拖动板块标题栏到目标板块的上 / 下 / 左 / 右边缘即可插入</span>
        <span class="spacer" />
        <button @click="resetLayout">恢复默认</button>
        <button class="primary" @click="setEditMode(false)">完成</button>
      </div>

      <div class="app-body">
        <DockNode class="dock-root" :node="layout.root" />
      </div>

      <!-- 插入预览：高亮目标板块的对应半边，直观表达插入后的占位 -->
      <div v-if="layoutUi.dropRect" class="drop-preview" :style="dropPreviewStyle" />
    </template>

    <ProjectDialog :open="historyOpen" @close="historyOpen = false" />
    <ExportDialog :open="exportOpen" @close="exportOpen = false" />
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
  min-height: 0;
  min-width: 0;
}

/* 布局树根节点撑满主工作区 */
.dock-root {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

/* 插入预览层：不受板块内部层叠上下文影响 */
.drop-preview {
  position: fixed;
  z-index: 500;
  pointer-events: none;
  background: var(--accent-soft);
  border: 2px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: 0 0 12px var(--accent);
  transition: left 0.12s ease, top 0.12s ease, width 0.12s ease, height 0.12s ease;
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
