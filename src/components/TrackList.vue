<script setup lang="ts">
/**
 * 左侧轨道面板
 * - 新增 MIDI 乐器轨 / 新增音频轨 / 新增编组轨 / 导入音频文件
 * - 轨道树展示：编组轨在前、子轨缩进紧随其后（MIDI / 音频 / 编组由 TrackRow 区分展示）
 */
import { computed, ref } from 'vue'
import type { InstrumentType, Track } from '@/types'
import { INSTRUMENT_OPTIONS } from '@/types'
import {
  addAudioTrack,
  addGroupTrack,
  addTrack,
  importAudioFile,
  openInstrumentManager,
  state,
  toggleVolumeDisplay
} from '@/core/store'
import TrackRow from './TrackRow.vue'

/** 新增轨道时的音色选择：内置音色用类型名，自定义音色用 `custom:<id>` */
const newInstrument = ref<string>('piano')
const audioInput = ref<HTMLInputElement | null>(null)

/** 「管理乐器与音源」哨兵值 */
const MANAGE_VALUE = '__manage__'

/** 工程内的自定义音源 */
const customInstruments = computed(() => state.project.customInstruments)

/** 新增轨道：解析下拉框的值（内置音色 / 自定义音源 / 打开管理器） */
function onAddTrack(): void {
  const value = newInstrument.value
  if (value === MANAGE_VALUE) {
    openInstrumentManager()
    newInstrument.value = 'piano'
    return
  }
  if (value.startsWith('custom:')) {
    addTrack('custom', value.slice('custom:'.length))
    return
  }
  addTrack(value as InstrumentType)
}

const noteCount = computed(() =>
  state.project.tracks.reduce(
    (sum, track) => sum + track.regions.reduce((s, region) => s + region.notes.length, 0),
    0
  )
)
const clipCount = computed(() =>
  state.project.tracks.reduce((sum, track) => sum + track.clips.length, 0)
)

/**
 * 轨道树展平结果：编组在前、其子轨紧随其后并缩进一级。
 * 这里只做展示排序，不改变工程里的轨道顺序（顺序仍由 moveTrack 维护）。
 */
const rows = computed<{ track: Track; depth: number }[]>(() => {
  const tracks = state.project.tracks
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const childrenOf = new Map<string, Track[]>()
  const roots: Track[] = []
  for (const track of tracks) {
    // 父级必须是一条真实存在的编组轨，否则视为根轨
    const parent = track.parentId ? byId.get(track.parentId) : undefined
    const pid = parent && parent.kind === 'group' ? parent.id : ''
    if (pid) {
      const list = childrenOf.get(pid)
      if (list) list.push(track)
      else childrenOf.set(pid, [track])
    } else {
      roots.push(track)
    }
  }
  const out: { track: Track; depth: number }[] = []
  const visit = (track: Track, depth: number): void => {
    out.push({ track, depth })
    for (const child of childrenOf.get(track.id) ?? []) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  return out
})

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
        <optgroup v-if="customInstruments.length" label="自定义音源">
          <option v-for="ci in customInstruments" :key="ci.id" :value="`custom:${ci.id}`">
            {{ ci.name }}（{{ ci.kind === 'drum' ? '鼓组' : '旋律' }}）
          </option>
        </optgroup>
        <option :value="MANAGE_VALUE">管理乐器与音源…</option>
      </select>
      <button title="新增 MIDI 乐器轨道" @click="onAddTrack">＋</button>
    </div>

    <div class="head sub">
      <button class="wide" title="新增一条空音频轨，可录音或导入音频填充" @click="addAudioTrack()">
        ＋ 音频轨
      </button>
      <button class="wide" title="把本地音频文件导入为波形片段" @click="audioInput?.click()">导入音频</button>
      <button class="wide" title="新增一条空编组轨，可把多条轨道收纳进来统一加效果与调音量" @click="addGroupTrack()">
        ＋ 编组
      </button>
      <input ref="audioInput" type="file" accept="audio/*" class="hidden-file" @change="onAudioChange" />
    </div>

    <div class="list">
      <TrackRow
        v-for="row in rows"
        :key="row.track.id"
        :track="row.track"
        :depth="row.depth"
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
