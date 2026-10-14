<script setup lang="ts">
/**
 * 单条轨道行：名称 / 音色 / 音量 / 声像 / Mute / Solo / 排序 / 删除
 */
import { computed } from 'vue'
import type { InstrumentType, Track } from '@/types'
import { INSTRUMENT_OPTIONS } from '@/types'
import {
  state,
  moveTrack,
  removeTrack,
  renameTrack,
  selectTrack,
  setTrackInstrument,
  setTrackPan,
  setTrackVolume,
  toggleMute,
  toggleSolo
} from '@/core/store'
import { formatVolume } from '@/utils/audio'

const props = defineProps<{ track: Track; index: number }>()

const selected = computed(() => state.selectedTrackId === props.track.id)
/** 是否为音频轨：音频轨没有音色选择，改为展示片段数量 */
const isAudio = computed(() => props.track.kind === 'audio')
/** 音量读数：随全局显示单位在 dB 与线性百分比之间切换 */
const volumeText = computed(() => formatVolume(props.track.volume, state.volumeDisplay))
const volumeUnitTitle = computed(() =>
  state.volumeDisplay === 'linear' ? '增益（线性 0~100%）' : '增益（dB）'
)
const panText = computed(() => {
  const pan = props.track.pan
  if (Math.abs(pan) < 0.02) return 'C'
  return pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`
})

function onNameChange(event: Event): void {
  renameTrack(props.track.id, (event.target as HTMLInputElement).value.trim())
}

function onInstrumentChange(event: Event): void {
  setTrackInstrument(props.track.id, (event.target as HTMLSelectElement).value as InstrumentType)
}

function onVolumeInput(event: Event): void {
  setTrackVolume(props.track.id, Number((event.target as HTMLInputElement).value))
}

function onPanInput(event: Event): void {
  setTrackPan(props.track.id, Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="track-row" :class="{ selected }" @click="selectTrack(track.id)">
    <div class="line">
      <span class="dot" :style="{ background: track.color }" />
      <input class="name" :value="track.name" title="轨道名称" @change="onNameChange" />
      <button class="mini" title="上移" @click.stop="moveTrack(track.id, -1)">↑</button>
      <button class="mini" title="下移" @click.stop="moveTrack(track.id, 1)">↓</button>
      <button class="mini danger" title="删除轨道" @click.stop="removeTrack(track.id)">✕</button>
    </div>

    <div class="line">
      <select v-if="!isAudio" class="inst" :value="track.instrument" @change="onInstrumentChange">
        <option v-for="option in INSTRUMENT_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <template v-else>
        <span class="badge">音频</span>
        <span class="clips">{{ track.clips.length }} 个波形片段</span>
      </template>
      <span class="spacer" />
      <button class="mini toggle" :class="{ on: track.mute }" title="静音" @click.stop="toggleMute(track.id)">
        M
      </button>
      <button class="mini toggle solo" :class="{ on: track.solo }" title="独奏" @click.stop="toggleSolo(track.id)">
        S
      </button>
    </div>

    <div class="line slider-line">
      <span class="label">音量</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="track.volume"
        title="音量推子（线性增益 0~1）"
        @input="onVolumeInput"
      />
      <span class="value" :title="volumeUnitTitle">{{ volumeText }}</span>
    </div>

    <div class="line slider-line">
      <span class="label">声像</span>
      <input
        type="range"
        min="-1"
        max="1"
        step="0.02"
        :value="track.pan"
        title="声像 -1(左) ~ 1(右)"
        @input="onPanInput"
      />
      <span class="value">{{ panText }}</span>
    </div>
  </div>
</template>

<style scoped>
.track-row {
  padding: 6px 8px 8px;
  border-bottom: 1px solid var(--line);
  border-left: 3px solid transparent;
  cursor: pointer;
  transition: background 0.15s ease;
}

.track-row:hover {
  background: var(--panel-2);
}

.track-row.selected {
  background: #232833;
  border-left-color: var(--accent);
}

.line {
  display: flex;
  align-items: center;
  gap: 5px;
}

.line + .line {
  margin-top: 5px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.name {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 1px solid transparent;
  padding: 2px 4px;
}

.name:hover,
.name:focus {
  background: var(--panel-2);
  border-color: var(--line);
}

.mini {
  padding: 2px 6px;
  line-height: 1.1;
  font-size: 12px;
}

.danger:hover {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.inst {
  flex: 1;
  min-width: 0;
}

.spacer {
  flex: 1;
  min-width: 0;
}

/* 音频轨标识 */
.badge {
  font-size: 10px;
  line-height: 1.4;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent);
  flex: 0 0 auto;
}

.clips {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toggle {
  width: 26px;
  padding: 2px 0;
  text-align: center;
  font-weight: 600;
}

.toggle.on {
  background: var(--accent-2);
  border-color: var(--accent-2);
  color: #fff;
}

.toggle.solo.on {
  background: var(--ok);
  border-color: var(--ok);
  color: #10231a;
}

.slider-line .label {
  width: 26px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.slider-line input[type='range'] {
  flex: 1;
  min-width: 0;
}

.slider-line .value {
  width: 30px;
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}
</style>
