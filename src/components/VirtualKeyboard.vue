<script setup lang="ts">
/**
 * 屏幕虚拟键盘
 * - 鼠标点击 / 拖动实时弹奏当前选中轨道的音色
 * - 播放时对应音高会高亮
 * - 支持电脑键盘映射：A W S E D F T G Y H U J K → 一个八度
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { activeTrack, previewAttack, previewRelease, setKeyboardVelocity, state } from '@/core/store'
import { clamp, midiToNoteName } from '@/utils/music'
import { velocityToMidi } from '@/utils/audio'

/** 白键半音偏移（一个八度内） */
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11]
/** 黑键半音偏移 */
const BLACK_OFFSETS = [1, 3, 6, 8, 10]
/** 电脑键盘映射（相对起始八度的半音偏移） */
const KEY_MAP: Record<string, number> = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12
}

const OCTAVES = 2
/** 起始音（默认 C3） */
const baseMidi = ref(48)
const held = ref<number[]>([])
const keyboardHeld = new Set<number>()

const currentTrack = computed(() => activeTrack())
const instrumentLabel = computed(() => currentTrack.value?.name ?? '未选择轨道')

/** 白键列表 */
const whiteKeys = computed(() => {
  const list: { midi: number; index: number }[] = []
  for (let octave = 0; octave < OCTAVES; octave += 1) {
    WHITE_OFFSETS.forEach((offset, i) => {
      list.push({ midi: baseMidi.value + octave * 12 + offset, index: octave * 7 + i })
    })
  }
  return list
})

const totalWhite = computed(() => whiteKeys.value.length)
const whiteWidth = computed(() => 100 / totalWhite.value)

/** 黑键列表（含绝对定位百分比） */
const blackKeys = computed(() => {
  const list: { midi: number; left: number; width: number }[] = []
  const w = whiteWidth.value
  const bw = w * 0.62
  for (let octave = 0; octave < OCTAVES; octave += 1) {
    for (let i = 0; i < WHITE_OFFSETS.length - 1; i += 1) {
      const offset = WHITE_OFFSETS[i] + 1
      if (!BLACK_OFFSETS.includes(offset)) continue
      const whiteIndex = octave * 7 + i
      list.push({
        midi: baseMidi.value + octave * 12 + offset,
        left: (whiteIndex + 1) * w - bw / 2,
        width: bw
      })
    }
  }
  return list
})

function isActive(midi: number): boolean {
  return held.value.includes(midi) || state.activePitches.includes(midi)
}

// ---------------------------------------------------------------- 演奏

function press(midi: number): void {
  const trackId = state.selectedTrackId
  if (!trackId) return
  if (held.value.includes(midi)) return
  held.value = [...held.value, midi]
  previewAttack(trackId, midi)
}

function release(midi: number): void {
  const trackId = state.selectedTrackId
  const index = held.value.indexOf(midi)
  if (index < 0) return
  held.value = held.value.filter((m) => m !== midi)
  if (trackId) previewRelease(trackId, midi)
}

function releaseAll(): void {
  const trackId = state.selectedTrackId
  if (trackId) held.value.forEach((midi) => previewRelease(trackId, midi))
  held.value = []
}

function onKeyPointerDown(event: PointerEvent, midi: number): void {
  event.preventDefault()
  press(midi)
}

/** 按住鼠标横向滑动 = 滑音 */
function onKeyPointerEnter(event: PointerEvent, midi: number): void {
  if (event.buttons !== 1) return
  held.value.forEach((m) => release(m))
  press(midi)
}

function onKeyPointerLeave(midi: number): void {
  if (held.value.includes(midi)) release(midi)
}

// ---------------------------------------------------------------- 八度切换

function shiftOctave(delta: number): void {
  releaseAll()
  // 保持键盘范围在 C0~C7 之间
  baseMidi.value = clamp(baseMidi.value + delta * 12, 12, 96 - (OCTAVES * 12 - 1))
}

// ---------------------------------------------------------------- 力度

/** 调整弹奏力度（0~1），影响试听与键盘演奏的强弱 */
function onVelocityInput(event: Event): void {
  setKeyboardVelocity(Number((event.target as HTMLInputElement).value))
}

// ---------------------------------------------------------------- 电脑键盘

function onWindowKeyDown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return
  const offset = KEY_MAP[event.key.toLowerCase()]
  if (offset === undefined) return
  event.preventDefault()
  const midi = baseMidi.value + offset
  if (keyboardHeld.has(midi)) return
  keyboardHeld.add(midi)
  press(midi)
}

function onWindowKeyUp(event: KeyboardEvent): void {
  const offset = KEY_MAP[event.key.toLowerCase()]
  if (offset === undefined) return
  const midi = baseMidi.value + offset
  keyboardHeld.delete(midi)
  release(midi)
}

onMounted(() => {
  window.addEventListener('pointerup', releaseAll)
  window.addEventListener('keydown', onWindowKeyDown)
  window.addEventListener('keyup', onWindowKeyUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', releaseAll)
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('keyup', onWindowKeyUp)
  releaseAll()
})
</script>

<template>
  <div class="keyboard-panel">
    <div class="head">
      <button class="mini" title="降低八度" @click="shiftOctave(-1)">◀</button>
      <span class="label">{{ midiToNoteName(baseMidi) }} ~ {{ midiToNoteName(baseMidi + OCTAVES * 12 - 1) }}</span>
      <button class="mini" title="升高八度" @click="shiftOctave(1)">▶</button>
      <span class="gap" />
      <label class="vel" title="弹奏力度（0~127）">
        力度
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          :value="state.keyboardVelocity"
          @input="onVelocityInput"
        />
        <span class="vel-val">{{ velocityToMidi(state.keyboardVelocity) }}</span>
      </label>
      <span class="dim">正在弹奏：{{ instrumentLabel }}</span>
    </div>

    <!-- 设备还原度提示：不同机型 / 扬声器能还原的音区不同 -->
    <div class="note-hint">
      提示：部分机型 / 扬声器无法很好地还原过低或过高的音区，可能出现破音甚至无声。
    </div>

    <div class="keys">
      <!-- 白键 -->
      <div
        v-for="key in whiteKeys"
        :key="key.midi"
        class="white"
        :class="{ on: isActive(key.midi) }"
        :style="{ width: whiteWidth + '%' }"
        @pointerdown="onKeyPointerDown($event, key.midi)"
        @pointerenter="onKeyPointerEnter($event, key.midi)"
        @pointerleave="onKeyPointerLeave(key.midi)"
      >
        <span v-if="key.midi % 12 === 0" class="key-label">{{ midiToNoteName(key.midi) }}</span>
      </div>

      <!-- 黑键 -->
      <div
        v-for="key in blackKeys"
        :key="key.midi"
        class="black"
        :class="{ on: isActive(key.midi) }"
        :style="{ left: key.left + '%', width: key.width + '%' }"
        @pointerdown="onKeyPointerDown($event, key.midi)"
        @pointerenter="onKeyPointerEnter($event, key.midi)"
        @pointerleave="onKeyPointerLeave(key.midi)"
      />
    </div>
  </div>
</template>

<style scoped>
.keyboard-panel {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 6px 10px 10px;
  gap: 6px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
}

.label {
  font-variant-numeric: tabular-nums;
  color: var(--text);
}

.gap {
  flex: 1;
}

.note-hint {
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim);
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: none;
}

.mini {
  padding: 1px 7px;
  font-size: 11px;
}

.vel {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 11px;
}

.vel input[type='range'] {
  width: 76px;
}

.vel-val {
  width: 26px;
  text-align: right;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.keys {
  position: relative;
  flex: 1;
  min-height: 84px;
  display: flex;
  border-radius: 4px;
  overflow: hidden;
  user-select: none;
  touch-action: none;
}

.white {
  position: relative;
  height: 100%;
  background: linear-gradient(180deg, #f4f5f8 0%, #d7dae2 100%);
  border-right: 1px solid #a9adba;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 3px;
  cursor: pointer;
}

.white:last-child {
  border-right: none;
}

.white.on {
  background: linear-gradient(180deg, #ffd0d9 0%, #ff8ea5 100%);
}

.key-label {
  font-size: 9px;
  color: #6a6f7e;
  pointer-events: none;
}

.black {
  position: absolute;
  top: 0;
  height: 62%;
  background: linear-gradient(180deg, #3a3d46 0%, #16171b 100%);
  border: 1px solid #0b0c0f;
  border-radius: 0 0 3px 3px;
  cursor: pointer;
  z-index: 2;
}

.black.on {
  background: linear-gradient(180deg, #ff7d97 0%, #c92a4b 100%);
}
</style>
