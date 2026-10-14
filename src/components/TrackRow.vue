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
  openInstrumentManager,
  removeTrack,
  renameTrack,
  selectTrack,
  setTrackInstrument,
  setTrackPan,
  setTrackParent,
  setTrackVolume,
  toggleMute,
  toggleSolo
} from '@/core/store'
import { formatVolume } from '@/utils/audio'

const props = defineProps<{ track: Track; depth: number }>()

const selected = computed(() => state.selectedTrackId === props.track.id)
/** 是否为音频轨：音频轨没有音色选择，改为展示片段数量 */
const isAudio = computed(() => props.track.kind === 'audio')
/** 是否为编组 / 总线轨：自身不发声，仅汇总子轨 */
const isGroup = computed(() => props.track.kind === 'group')
/** 树形缩进：每深一级左移 14px，让子轨在视觉上隶属于编组 */
const indentStyle = computed(() => ({ paddingLeft: `${8 + props.depth * 14}px` }))

/** 编组轨的子轨数量（用于展示汇总信息） */
const childCount = computed(
  () => state.project.tracks.filter((t) => t.parentId === props.track.id).length
)

/**
 * 可作为父编组的候选：全部编组轨，排除自身与自身的后代 ——
 * 否则父子互指会让信号链成环。
 */
const groupOptions = computed(() => {
  const byId = new Map(state.project.tracks.map((t) => [t.id, t]))
  const isDescendant = (candidateId: string): boolean => {
    let cursor = byId.get(candidateId)
    let guard = 0
    while (cursor && guard < 32) {
      if (cursor.parentId === props.track.id) return true
      cursor = byId.get(cursor.parentId)
      guard += 1
    }
    return false
  }
  return state.project.tracks.filter(
    (t) => t.kind === 'group' && t.id !== props.track.id && !isDescendant(t.id)
  )
})

function onParentChange(event: Event): void {
  setTrackParent(props.track.id, (event.target as HTMLSelectElement).value)
}

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

/** 工程内的自定义音源（供音色下拉框动态列出） */
const customInstruments = computed(() => state.project.customInstruments)

/**
 * 下拉框的当前值：内置音色直接用类型名，
 * 自定义音色用 `custom:<id>` 复合值，以便区分多套自定义音源。
 */
const instrumentValue = computed(() =>
  props.track.instrument === 'custom'
    ? `custom:${props.track.customInstrumentId}`
    : props.track.instrument
)

/** 「管理乐器与音源」哨兵值：选中后打开管理器并还原选择 */
const MANAGE_VALUE = '__manage__'

function onNameChange(event: Event): void {
  renameTrack(props.track.id, (event.target as HTMLInputElement).value.trim())
}

function onInstrumentChange(event: Event): void {
  const select = event.target as HTMLSelectElement
  const value = select.value
  if (value === MANAGE_VALUE) {
    openInstrumentManager()
    // 该选项不是真实音色，还原下拉框显示，避免轨道被误改为空音色
    select.value = instrumentValue.value
    return
  }
  if (value.startsWith('custom:')) {
    setTrackInstrument(props.track.id, 'custom', value.slice('custom:'.length))
    return
  }
  setTrackInstrument(props.track.id, value as InstrumentType)
}

function onVolumeInput(event: Event): void {
  setTrackVolume(props.track.id, Number((event.target as HTMLInputElement).value))
}

function onPanInput(event: Event): void {
  setTrackPan(props.track.id, Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="track-row" :class="{ selected, group: isGroup }" :style="indentStyle" @click="selectTrack(track.id)">
    <div class="line">
      <span class="dot" :style="{ background: track.color }" />
      <input class="name" :value="track.name" title="轨道名称" @change="onNameChange" />
      <button class="mini" title="上移" @click.stop="moveTrack(track.id, -1)">↑</button>
      <button class="mini" title="下移" @click.stop="moveTrack(track.id, 1)">↓</button>
      <button class="mini danger" title="删除轨道" @click.stop="removeTrack(track.id)">✕</button>
    </div>

    <div class="line">
      <template v-if="isGroup">
        <span class="badge">编组</span>
        <span class="clips">{{ childCount }} 条子轨</span>
      </template>
      <select v-else-if="!isAudio" class="inst" :value="instrumentValue" @change="onInstrumentChange">
        <option v-for="option in INSTRUMENT_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
        <optgroup v-if="customInstruments.length" label="自定义音源">
          <option v-for="ci in customInstruments" :key="ci.id" :value="`custom:${ci.id}`">
            {{ ci.name }}（{{ ci.kind === 'drum' ? '鼓组' : '旋律' }}）
          </option>
        </optgroup>
        <option :value="MANAGE_VALUE">管理乐器与音源…</option>
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

    <!-- 归属编组：选择后本轨（或本编组）的信号汇入该编组总线，统一加效果与调音量 -->
    <div v-if="groupOptions.length" class="line slider-line">
      <span class="label">编组</span>
      <select class="parent" :value="track.parentId" title="归属编组（无 = 直接接入主干）" @change="onParentChange">
        <option value="">无（主干）</option>
        <option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ group.name }}</option>
      </select>
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

/* 编组 / 总线轨：底色略深，强调它是子轨的汇总节点 */
.track-row.group {
  background: var(--panel-2);
}

.track-row.group.selected {
  background: #232833;
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

/* 归属编组下拉框：占据剩余宽度 */
.parent {
  flex: 1;
  min-width: 0;
  font-size: 11px;
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
