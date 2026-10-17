<script setup lang="ts">
/**
 * 导出音频弹窗：范围（整首 / 小节区间）、位深、采样率、混音 / 分轨
 */
import { computed, ref } from 'vue'
import { exportAudioWav, state } from '@/core/store'
import { beatsPerBarOf, secondsBetweenBeats } from '@/utils/music'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

/** 起始 / 结束小节（1 基，闭区间） */
const fromBar = ref(1)
const toBar = ref(state.project.bars)
/** 位深 */
const bitDepth = ref<16 | 24>(16)
/** 采样率：0 表示跟随浏览器音频上下文 */
const sampleRate = ref(0)
/** 导出方式：mix 混音单文件 / stems 分轨多文件 */
const mode = ref<'mix' | 'stems'>('mix')

const totalBars = computed(() => state.project.bars)
const beatsPerBar = computed(() => beatsPerBarOf(state.project.timeSignature))
/** 选区时长（拍），供预览显示 */
const rangeBeats = computed(() => {
  const from = clampBar(fromBar.value, 1)
  const to = clampBar(toBar.value, from)
  return (to - from + 1) * beatsPerBar.value
})
/** 选区时长（秒）：按速度曲线精确积分 */
const rangeSeconds = computed(() => {
  const from = clampBar(fromBar.value, 1)
  const to = clampBar(toBar.value, from)
  const beatsPer = beatsPerBar.value
  const fromBeat = (from - 1) * beatsPer
  const toBeat = to * beatsPer
  return secondsBetweenBeats(fromBeat, toBeat, state.project.tempoPoints, state.project.bpm)
})

function clampBar(value: number, min: number): number {
  return Math.min(Math.max(Math.round(value) || min, min), totalBars.value)
}

function onFromInput(event: Event): void {
  const value = clampBar(Number((event.target as HTMLInputElement).value), 1)
  fromBar.value = value
  if (toBar.value < value) toBar.value = value
}

function onToInput(event: Event): void {
  const from = clampBar(fromBar.value, 1)
  toBar.value = clampBar(Number((event.target as HTMLInputElement).value), from)
}

/** 估算分轨导出的文件数（编组轨不产生文件） */
const stemCount = computed(() => state.project.tracks.filter((t) => t.kind !== 'group').length)

async function onExport(): Promise<void> {
  const from = clampBar(fromBar.value, 1)
  const to = clampBar(toBar.value, from)
  await exportAudioWav({
    fromBar: from - 1,
    toBar: to,
    bitDepth: bitDepth.value,
    sampleRate: sampleRate.value > 0 ? sampleRate.value : undefined,
    stems: mode.value === 'stems'
  })
}

function onClose(): void {
  // 渲染进行中不允许关闭，避免状态与弹窗不同步
  if (state.busy) return
  emit('close')
}
</script>

<template>
  <Transition name="mask-fade">
    <div v-if="open" class="mask" @click.self="onClose">
      <div class="dialog">
        <header class="head">
          <strong>导出音频</strong>
          <span class="dim">WAV · {{ state.project.name }}</span>
          <span class="gap" />
          <button :disabled="state.busy" @click="onClose">关闭</button>
        </header>

        <div class="body">
          <section class="group">
            <h3>导出范围</h3>
            <div class="row">
              <label class="field">
                <span>起始小节</span>
                <input type="number" min="1" :max="totalBars" :value="fromBar" @input="onFromInput" />
              </label>
              <span class="dash">–</span>
              <label class="field">
                <span>结束小节</span>
                <input type="number" min="1" :max="totalBars" :value="toBar" @input="onToInput" />
              </label>
              <button class="ghost" :disabled="state.busy" @click="fromBar = 1; toBar = totalBars">
                整首
              </button>
            </div>
            <p class="hint">
              共 {{ Math.abs(clampBar(toBar, clampBar(fromBar, 1)) - clampBar(fromBar, 1)) + 1 }} 小节 ·
              约 {{ rangeBeats.toFixed(0) }} 拍（{{ rangeSeconds.toFixed(1) }} 秒）
            </p>
          </section>

          <section class="group">
            <h3>格式</h3>
            <div class="row">
              <label class="field">
                <span>位深</span>
                <select v-model="bitDepth">
                  <option :value="16">16 bit</option>
                  <option :value="24">24 bit</option>
                </select>
              </label>
              <label class="field">
                <span>采样率</span>
                <select v-model.number="sampleRate">
                  <option :value="0">跟随浏览器</option>
                  <option :value="44100">44100 Hz</option>
                  <option :value="48000">48000 Hz</option>
                </select>
              </label>
            </div>
          </section>

          <section class="group">
            <h3>导出方式</h3>
            <label class="radio">
              <input v-model="mode" type="radio" value="mix" />
              <span>混音导出<small>全部轨道合成一个文件</small></span>
            </label>
            <label class="radio">
              <input v-model="mode" type="radio" value="stems" />
              <span>分轨导出<small>每条轨道单独一个文件（{{ stemCount }} 个，编组轨不单独导出）</small></span>
            </label>
            <p v-if="mode === 'stems'" class="hint">
              分轨忽略目标轨自身的静音状态；导出起点之前的片段不会发声。
            </p>
          </section>
        </div>

        <footer class="foot">
          <span class="status">{{ state.busy ? state.statusText : '' }}</span>
          <span class="gap" />
          <button class="primary" :disabled="state.busy" @click="onExport">
            {{ state.busy ? '正在导出…' : '导出 WAV' }}
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  width: 440px;
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  animation: dialog-rise-in 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.gap {
  flex: 1;
}

.dim {
  color: var(--text-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.body {
  overflow-y: auto;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.group h3 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 600;
}

.row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-dim);
}

.field input,
.field select {
  width: 110px;
}

.dash {
  color: var(--text-dim);
  padding-bottom: 6px;
}

.ghost {
  font-size: 12px;
}

.hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-dim);
}

.radio {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
  font-size: 13px;
}

.radio span {
  display: flex;
  flex-direction: column;
  line-height: 1.4;
}

.radio small {
  color: var(--text-dim);
  font-size: 11px;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}

.status {
  font-size: 12px;
  color: var(--text-dim);
}

.primary {
  border-color: var(--accent);
  color: var(--accent);
}

.primary:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
