<script setup lang="ts">
/**
 * 左侧轨道面板
 * - 新增 MIDI 乐器轨 / 新增音频轨 / 导入音频文件
 * - 轨道列表（MIDI 与音频轨混排，由 TrackRow 自行区分展示）
 */
import { computed, ref } from 'vue'
import type { InstrumentType } from '@/types'
import { INSTRUMENT_OPTIONS } from '@/types'
import { addAudioTrack, addTrack, importAudioFile, state, toggleVolumeDisplay } from '@/core/store'
import TrackRow from './TrackRow.vue'

const newInstrument = ref<InstrumentType>('piano')
const audioInput = ref<HTMLInputElement | null>(null)

const noteCount = computed(() =>
  state.project.tracks.reduce(
    (sum, track) => sum + track.regions.reduce((s, region) => s + region.notes.length, 0),
    0
  )
)
const clipCount = computed(() =>
  state.project.tracks.reduce((sum, track) => sum + track.clips.length, 0)
)

async function onAudioChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await importAudioFile(file)
  // 清空以便重复导入同一个文件
  input.value = ''
}
</script>

<template>
  <aside class="track-panel">
    <div class="head">
      <span class="title">轨道</span>
      <button
        class="unit"
        :class="{ active: state.volumeDisplay === 'linear' }"
        :title="
          state.volumeDisplay === 'linear'
            ? '音量读数：线性百分比，点击切回 dB'
            : '音量读数：dB，点击切换为线性百分比'
        "
        @click="toggleVolumeDisplay"
      >
        {{ state.volumeDisplay === 'linear' ? '线性' : 'dB' }}
      </button>
      <span class="spacer" />
      <select v-model="newInstrument" class="inst" title="选择要新增的音色">
        <option v-for="option in INSTRUMENT_OPTIONS" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <button title="新增 MIDI 乐器轨道" @click="addTrack(newInstrument)">＋</button>
    </div>

    <div class="head sub">
      <button class="wide" title="新增一条空音频轨，可录音或导入音频填充" @click="addAudioTrack()">
        ＋ 音频轨
      </button>
      <button class="wide" title="把本地音频文件导入为波形片段" @click="audioInput?.click()">导入音频</button>
      <input ref="audioInput" type="file" accept="audio/*" class="hidden-file" @change="onAudioChange" />
    </div>

    <div class="list">
      <TrackRow
        v-for="(track, index) in state.project.tracks"
        :key="track.id"
        :track="track"
        :index="index"
      />
      <p v-if="!state.project.tracks.length" class="empty">还没有轨道，点右上角「＋」新增</p>
    </div>

    <div class="foot">
      <span>{{ state.project.tracks.length }} 条轨道</span>
      <span>{{ noteCount }} 音符 · {{ clipCount }} 片段</span>
    </div>
  </aside>
</template>

<style scoped>
.track-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
}

.head.sub {
  padding: 6px 8px;
}

.wide {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}

.title {
  font-weight: 600;
}

.unit {
  padding: 2px 7px;
  font-size: 11px;
  line-height: 1.2;
}

.unit:not(.active) {
  color: var(--text-dim);
}

.spacer {
  flex: 1;
}

.inst {
  max-width: 84px;
}

.hidden-file {
  display: none;
}

.list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.empty {
  color: var(--text-dim);
  padding: 16px 12px;
  line-height: 1.6;
}

.foot {
  display: flex;
  justify-content: space-between;
  padding: 6px 10px;
  border-top: 1px solid var(--line);
  color: var(--text-dim);
}
</style>
