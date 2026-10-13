<script setup lang="ts">
/**
 * 主输出面板（常驻底部栏）
 * 总音量 + 总线电平表 + 限幅指示 + 混响返回 + 限幅阈值
 * 更完整的通道级混音请切换到「混音台」视图
 */
import { computed } from 'vue'
import { setLimiterThreshold, setMasterVolume, setReverbWet, state } from '@/core/store'
import { LIMITER_MAX, LIMITER_MIN } from '@/types'
import { formatVolume } from '@/utils/audio'

/** 总音量读数：随全局显示单位在 dB 与线性百分比之间切换 */
const masterVolumeText = computed(() => formatVolume(state.project.masterVolume, state.volumeDisplay))
const masterUnitTitle = computed(() =>
  state.volumeDisplay === 'linear' ? '增益（线性 0~100%）' : '增益（dB）'
)
const wetPercent = computed(() => Math.round(state.project.reverbWet * 100))

/** 电平 0~1 → 百分比宽度（开方让低电平也可见） */
const levelWidth = computed(() => Math.min(100, Math.sqrt(Math.max(0, state.masterLevel)) * 100))

function onMasterInput(event: Event): void {
  setMasterVolume(Number((event.target as HTMLInputElement).value))
}

function onWetInput(event: Event): void {
  setReverbWet(Number((event.target as HTMLInputElement).value))
}

function onLimiterInput(event: Event): void {
  setLimiterThreshold(Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <aside class="master-panel">
    <div class="title">
      <span>总输出 Master</span>
      <span class="led" :class="{ on: state.limiting }" :title="state.limiting ? '限幅中' : '未触发'" />
    </div>

    <div class="meter" title="总线输出电平">
      <div class="meter-fill" :style="{ width: levelWidth + '%' }" />
    </div>

    <label class="row">
      <span class="label">音量</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="state.project.masterVolume"
        title="总音量（线性增益 0~1）"
        @input="onMasterInput"
      />
      <span class="value" :title="masterUnitTitle">{{ masterVolumeText }}</span>
    </label>

    <label class="row">
      <span class="label">混响</span>
      <input type="range" min="0" max="1" step="0.01" :value="state.project.reverbWet" @input="onWetInput" />
      <span class="value">{{ wetPercent }}</span>
    </label>

    <label class="row">
      <span class="label">限幅</span>
      <input
        type="range"
        :min="LIMITER_MIN"
        :max="LIMITER_MAX"
        step="1"
        :value="state.project.masterLimiter"
        @input="onLimiterInput"
      />
      <span class="value">{{ state.project.masterLimiter }}</span>
    </label>

    <p class="tip">干声 + 混响总线 → 总音量 → 限幅 → 扬声器</p>
  </aside>
</template>

<style scoped>
.master-panel {
  width: 232px;
  flex: 0 0 232px;
  border-left: 1px solid var(--line);
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: var(--panel);
  overflow: hidden;
}

.title {
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.led {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #3a3e4a;
  border: 1px solid var(--line);
}

.led.on {
  background: var(--accent-2);
  border-color: var(--accent-2);
  box-shadow: 0 0 6px var(--accent-2);
}

.meter {
  height: 6px;
  border-radius: 3px;
  background: #14151a;
  border: 1px solid var(--line);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  background-image: linear-gradient(to right, #63c78d 0%, #e8c34f 72%, #ff4d6d 100%);
  background-size: 210px 100%;
  background-position: left;
  background-repeat: no-repeat;
  transition: width 0.06s linear;
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
  line-height: 1.5;
}
</style>
