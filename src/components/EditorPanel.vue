<script setup lang="ts">
/**
 * 中央编辑区板块
 * - piano 视图：时间总轨 + 钢琴卷帘
 * - audio 视图：时间总轨 + 波形编辑器（音频轨专用）
 * - mixer 视图：混音台
 * 视图由 state.viewMode 决定，选中音频轨时 store 会自动切到 audio 视图。
 * 音符检查器已拆分为独立板块（id: inspector），可单独参与布局编排。
 * 作为可编排板块，根容器撑满所在区域。
 */
import { computed } from 'vue'
import TimelineRuler from './TimelineRuler.vue'
import PianoRoll from './PianoRoll.vue'
import MixerPanel from './MixerPanel.vue'
import AudioEditor from './AudioEditor.vue'
import { state } from '@/core/store'

const mode = computed(() => state.viewMode)
</script>

<template>
  <div class="editor-panel">
    <MixerPanel v-if="mode === 'mixer'" />

    <template v-else>
      <TimelineRuler />
      <div class="editor-split">
        <PianoRoll v-if="mode === 'piano'" />
        <AudioEditor v-else />
      </div>
    </template>
  </div>
</template>

<style scoped>
.editor-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 主编辑器容器（撑满剩余空间） */
.editor-split {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}
</style>
