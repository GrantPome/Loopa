<script setup lang="ts">
/**
 * 音符检查器（Note Inspector）
 * 显示并精确编辑当前选中的音符：
 * - 单个音符：音高、起始、时长、力度逐项可编辑
 * - 多个音符：统一设置力度 / 时长，整体移调，并显示力度统计
 * 所有修改都通过 store 的 patchSelectedNotes 走统一入口，自动触发重绘与音频重排。
 */
import { computed } from 'vue'
import { activeRegion, patchSelectedNotes, state, transposeSelectedNotes } from '@/core/store'
import { MAX_MIDI, MIN_MIDI, clamp, midiToNoteName } from '@/utils/music'
import { midiToVelocity, velocityToMidi } from '@/utils/audio'

/** 当前选中的音符列表 */
const selected = computed(() => {
  const region = activeRegion()
  if (!region) return []
  const ids = new Set(state.selectedNoteIds)
  return region.notes.filter((n) => ids.has(n.id))
})

const count = computed(() => selected.value.length)
/** 单选时的音符 */
const single = computed(() => (selected.value.length === 1 ? selected.value[0] : null))

/** 多选时的力度统计（最小/最大/平均，均以 MIDI 力度显示） */
const velocityStats = computed(() => {
  const list = selected.value
  if (list.length === 0) return null
  let min = 1
  let max = 0
  let sum = 0
  for (const note of list) {
    min = Math.min(min, note.velocity)
    max = Math.max(max, note.velocity)
    sum += note.velocity
  }
  return {
    min: velocityToMidi(min),
    max: velocityToMidi(max),
    avg: velocityToMidi(sum / list.length)
  }
})

/** 多选时的平均时长（拍），用于统一时长输入框的初始值 */
const durationAvg = computed(() => {
  const list = selected.value
  if (list.length === 0) return 0.25
  return Math.round((list.reduce((sum, n) => sum + n.duration, 0) / list.length) * 1000) / 1000
})

// ---------------------------------------------------------------- 编辑处理

/** 修改音高（半音） */
function onMidiInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  patchSelectedNotes({ midi: clamp(value, MIN_MIDI, MAX_MIDI) })
}

/** 修改起始位置（拍） */
function onStartInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  patchSelectedNotes({ start: value })
}

/** 修改时长（拍） */
function onDurationInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  patchSelectedNotes({ duration: value })
}

/** 修改力度（MIDI 0~127） */
function onVelocityInput(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (!Number.isFinite(value)) return
  patchSelectedNotes({ velocity: midiToVelocity(value) })
}

/** 整体移调 */
function onTranspose(semitones: number): void {
  transposeSelectedNotes(semitones)
}
</script>

<template>
  <aside class="inspector">
    <div class="title">
      <span>音符检查器</span>
      <span class="count">{{ count ? `${count} 个` : '—' }}</span>
    </div>

    <p v-if="count === 0" class="empty">
      在钢琴卷帘中点击或框选音符后，可在这里精确编辑音高、时长与力度。
    </p>

    <!-- 单选：逐项精确编辑 -->
    <template v-else-if="single">
      <div class="row">
        <span class="label">音高</span>
        <span class="note-name">{{ midiToNoteName(single.midi) }}</span>
      </div>
      <div class="row">
        <input
          class="num"
          type="number"
          :min="MIN_MIDI"
          :max="MAX_MIDI"
          step="1"
          :value="single.midi"
          title="MIDI 音号"
          @change="onMidiInput"
        />
        <button class="mini" title="降半音" @click="onTranspose(-1)">−1</button>
        <button class="mini" title="升半音" @click="onTranspose(1)">+1</button>
      </div>

      <label class="field">
        <span class="label">起始</span>
        <input class="num" type="number" min="0" step="0.125" :value="single.start" @change="onStartInput" />
        <span class="unit">拍</span>
      </label>

      <label class="field">
        <span class="label">时长</span>
        <input
          class="num"
          type="number"
          min="0.0625"
          step="0.125"
          :value="single.duration"
          @change="onDurationInput"
        />
        <span class="unit">拍</span>
      </label>

      <div class="vel-block">
        <div class="row">
          <span class="label">力度</span>
          <input
            class="num"
            type="number"
            min="0"
            max="127"
            step="1"
            :value="velocityToMidi(single.velocity)"
            @change="onVelocityInput"
          />
          <span class="unit">/ 127</span>
        </div>
        <input
          type="range"
          min="0"
          max="127"
          step="1"
          :value="velocityToMidi(single.velocity)"
          title="拖动调整力度"
          @input="onVelocityInput"
        />
      </div>
    </template>

    <!-- 多选：批量设置 -->
    <template v-else>
      <div class="row stat">
        <span class="label">力度</span>
        <span class="stat-text">
          最小 {{ velocityStats?.min }} · 平均 {{ velocityStats?.avg }} · 最大 {{ velocityStats?.max }}
        </span>
      </div>

      <div class="vel-block">
        <div class="row">
          <span class="label">统一力度</span>
          <input
            class="num"
            type="number"
            min="0"
            max="127"
            step="1"
            :value="velocityStats?.avg ?? 100"
            @change="onVelocityInput"
          />
        </div>
        <input
          type="range"
          min="0"
          max="127"
          step="1"
          :value="velocityStats?.avg ?? 100"
          @input="onVelocityInput"
        />
      </div>

      <label class="field">
        <span class="label">统一时长</span>
        <input class="num" type="number" min="0.0625" step="0.125" :value="durationAvg" @change="onDurationInput" />
        <span class="unit">拍</span>
      </label>

      <div class="row transpose">
        <span class="label">移调</span>
        <button class="mini" title="降一个八度" @click="onTranspose(-12)">-12</button>
        <button class="mini" title="降半音" @click="onTranspose(-1)">-1</button>
        <button class="mini" title="升半音" @click="onTranspose(1)">+1</button>
        <button class="mini" title="升一个八度" @click="onTranspose(12)">+12</button>
      </div>
    </template>

    <p class="hint">提示：选中后可用 ↑ / ↓ 调力度，Shift + ↑ / ↓ 移调。</p>
  </aside>
</template>

<style scoped>
/* 作为独立板块：撑满所在面板，内容超出时自身滚动 */
.inspector {
  flex: 1;
  min-width: 0;
  min-height: 0;
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}

.title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}

.count {
  font-size: 11px;
  color: var(--text-dim);
  font-weight: 400;
}

.empty {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-dim);
}

.row {
  display: flex;
  align-items: center;
  gap: 5px;
}

.row.stat {
  justify-content: space-between;
}

.field {
  display: flex;
  align-items: center;
  gap: 5px;
}

.label {
  width: 52px;
  flex: 0 0 auto;
  color: var(--text-dim);
  font-size: 11px;
}

.unit {
  color: var(--text-dim);
  font-size: 11px;
}

.note-name {
  font-weight: 600;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.num {
  flex: 1;
  min-width: 0;
  width: 100%;
  font-variant-numeric: tabular-nums;
}

.stat-text {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.vel-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.vel-block input[type='range'] {
  width: 100%;
}

.mini {
  padding: 2px 6px;
  font-size: 11px;
  line-height: 1.1;
}

.transpose .mini {
  flex: 1;
  text-align: center;
}

.hint {
  margin: 0;
  margin-top: auto;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-dim);
}
</style>
