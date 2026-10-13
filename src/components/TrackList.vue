<script setup lang="ts">
/**
 * 左侧轨道面板：新增轨道 + 轨道列表
 */
import { computed, ref } from 'vue'
import type { InstrumentType } from '@/types'
import { INSTRUMENT_OPTIONS } from '@/types'
import { addTrack, state, toggleVolumeDisplay } from '@/core/store'
import TrackRow from './TrackRow.vue'

const newInstrument = ref<InstrumentType>('piano')

const noteCount = computed(() =>
  state.project.tracks.reduce(
    (sum, track) => sum + track.regions.reduce((s, region) => s + region.notes.length, 0),
    0
  )
)
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
      <span>{{ noteCount }} 个音符</span>
    </div>
  </aside>
</template>

<style scoped>
.track-panel {
  width: 288px;
  flex: 0 0 288px;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-right: 1px solid var(--line);
  min-height: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-bottom: 1px solid var(--line);
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
