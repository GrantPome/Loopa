<script setup lang="ts">
/**
 * 应用外壳：三栏布局
 * 顶部工具栏 / 左侧轨道面板 / 中部时间总轨 + 钢琴卷帘 / 底部虚拟键盘与总输出
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import TopToolbar from './components/TopToolbar.vue'
import TrackList from './components/TrackList.vue'
import TimelineRuler from './components/TimelineRuler.vue'
import PianoRoll from './components/PianoRoll.vue'
import VirtualKeyboard from './components/VirtualKeyboard.vue'
import MasterPanel from './components/MasterPanel.vue'
import ProjectDialog from './components/ProjectDialog.vue'
import { clearNoteSelection, deleteSelectedNotes, ensureAudio, togglePlay } from './core/store'

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

  if (event.code === 'Space') {
    event.preventDefault()
    void togglePlay()
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    deleteSelectedNotes()
  } else if (event.key === 'Escape') {
    historyOpen.value = false
    clearNoteSelection()
  }
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
  <div class="app">
    <TopToolbar @open-history="historyOpen = true" />

    <div class="main">
      <TrackList />
      <div class="editor">
        <TimelineRuler />
        <PianoRoll />
      </div>
    </div>

    <footer class="bottom">
      <VirtualKeyboard />
      <MasterPanel />
    </footer>

    <ProjectDialog :open="historyOpen" @close="historyOpen = false" />
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

.main {
  flex: 1;
  display: flex;
  min-height: 0;
}

.editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.bottom {
  flex: 0 0 152px;
  height: 152px;
  display: flex;
  border-top: 1px solid var(--line);
  background: var(--panel);
}
</style>
