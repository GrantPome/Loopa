<script setup lang="ts">
/**
 * 主输出面板：总音量 + 主混响湿度
 */
import { computed } from 'vue'
import { setMasterVolume, setReverbWet, state } from '@/core/store'

const masterPercent = computed(() => Math.round(state.project.masterVolume * 100))
const wetPercent = computed(() => Math.round(state.project.reverbWet * 100))

function onMasterInput(event: Event): void {
  setMasterVolume(Number((event.target as HTMLInputElement).value))
}

function onWetInput(event: Event): void {
  setReverbWet(Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <aside class="master-panel">
    <div class="title">总输出 Master</div>

    <label class="row">
      <span class="label">音量</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="state.project.masterVolume"
        @input="onMasterInput"
      />
      <span class="value">{{ masterPercent }}</span>
    </label>

    <label class="row">
      <span class="label">混响</span>
      <input type="range" min="0" max="1" step="0.01" :value="state.project.reverbWet" @input="onWetInput" />
      <span class="value">{{ wetPercent }}</span>
    </label>

    <p class="tip">主输出链路：轨道 → 声像 → 增益 → 总音量 → 混响 → 扬声器</p>
  </aside>
</template>

<style scoped>
.master-panel {
  width: 232px;
  flex: 0 0 232px;
  border-left: 1px solid var(--line);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--panel);
}

.title {
  font-weight: 600;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.label {
  width: 28px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.row input[type='range'] {
  flex: 1;
  min-width: 0;
}

.value {
  width: 30px;
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.tip {
  margin: 0;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.6;
}
</style>
