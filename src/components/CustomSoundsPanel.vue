<script setup lang="ts">
/**
 * 自定义音源面板（「乐器与音源」管理器的第二个页签）
 *
 * 用途：内置音色的采样并不齐全（例如鼓组只有踩镲、缺少吊镲），
 * 这里允许用户导入自己的采样，拼装成一套独立音色供轨道使用。
 *
 * 两种类型：
 * - 旋律音源（melodic）：按采样原始音高就近匹配 + 自动移调，可弹任意音高
 * - 鼓组音源（drum）：每个采样绑定一个 MIDI 音号，命中即原速播放（不移调）
 *
 * 采样 PCM 存入 IndexedDB，工程 JSON 只保存元信息与音号映射。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { CustomInstrumentKind, CustomSample } from '@/types'
import { GM_DRUM_NOTES, drumNoteLabel } from '@/types'
import {
  addCustomInstrument,
  importCustomSampleFile,
  previewCustomSample,
  removeCustomInstrument,
  removeCustomSample,
  renameCustomInstrument,
  setCustomInstrumentGain,
  setCustomInstrumentKind,
  state,
  stopInstrumentPreview,
  updateCustomSample
} from '@/core/store'
import { MAX_MIDI, MIN_MIDI, clamp, midiToNoteName } from '@/utils/music'

/** 当前选中的音源 id（空表示未选中） */
const selectedId = ref('')
/** 新建音源的表单 */
const newName = ref('')
const newKind = ref<CustomInstrumentKind>('melodic')
/** 采样文件选择框 */
const fileInput = ref<HTMLInputElement | null>(null)

const instruments = computed(() => state.project.customInstruments)
const selected = computed(
  () => instruments.value.find((c) => c.id === selectedId.value) ?? null
)

const kindOptions: { value: CustomInstrumentKind; label: string; desc: string }[] = [
  { value: 'melodic', label: '旋律音源', desc: '按原始音高移调，可弹任意音高' },
  { value: 'drum', label: '鼓组音源', desc: '每个采样绑定一个音号，原速播放' }
]

/** 音源类型说明文字 */
function kindDesc(kind: CustomInstrumentKind): string {
  return kindOptions.find((o) => o.value === kind)?.desc ?? ''
}

/** 采样在界面上的音高标注：鼓组显示 GM 鼓件名，旋律显示音名 */
function samplePitchLabel(sample: CustomSample): string {
  if (selected.value?.kind === 'drum') return drumNoteLabel(sample.midi)
  return midiToNoteName(sample.rootMidi)
}

/** 统计引用某套音源的轨道数（删除前提示用） */
function trackCountOf(id: string): number {
  return state.project.tracks.filter(
    (t) => t.kind === 'midi' && t.instrument === 'custom' && t.customInstrumentId === id
  ).length
}

// 首次渲染时自动选中第一套音源，避免右侧空白
watch(
  instruments,
  () => {
    if (!instruments.value.some((c) => c.id === selectedId.value)) {
      selectedId.value = instruments.value[0]?.id ?? ''
    }
  },
  { immediate: true }
)

function onCreate(): void {
  const id = addCustomInstrument(newName.value, newKind.value)
  selectedId.value = id
  newName.value = ''
}

function onRename(event: Event): void {
  if (!selected.value) return
  renameCustomInstrument(selected.value.id, (event.target as HTMLInputElement).value)
}

function onKindChange(event: Event): void {
  if (!selected.value) return
  setCustomInstrumentKind(
    selected.value.id,
    (event.target as HTMLSelectElement).value as CustomInstrumentKind
  )
}

function onGainInput(event: Event): void {
  if (!selected.value) return
  setCustomInstrumentGain(selected.value.id, Number((event.target as HTMLInputElement).value))
}

function onPickFile(): void {
  if (!selected.value) return
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const instrument = selected.value
  const files = Array.from(input.files ?? [])
  if (instrument) {
    for (const file of files) await importCustomSampleFile(instrument.id, file)
  }
  // 清空以便重复导入同一个文件
  input.value = ''
}

function onSampleName(event: Event, sample: CustomSample): void {
  if (!selected.value) return
  updateCustomSample(selected.value.id, sample.id, {
    name: (event.target as HTMLInputElement).value
  })
}

/** 鼓组采样：改绑定的 MIDI 音号 */
function onSampleMidi(event: Event, sample: CustomSample): void {
  if (!selected.value) return
  updateCustomSample(selected.value.id, sample.id, {
    midi: clamp(Number((event.target as HTMLSelectElement).value), MIN_MIDI, MAX_MIDI)
  })
}

/** 旋律采样：改原始音高（移调基准） */
function onSampleRoot(event: Event, sample: CustomSample): void {
  if (!selected.value) return
  updateCustomSample(selected.value.id, sample.id, {
    rootMidi: clamp(Number((event.target as HTMLInputElement).value), MIN_MIDI, MAX_MIDI)
  })
}

function onSampleGain(event: Event, sample: CustomSample): void {
  if (!selected.value) return
  updateCustomSample(selected.value.id, sample.id, {
    gain: Number((event.target as HTMLInputElement).value)
  })
}

function onRemoveSample(sample: CustomSample): void {
  if (!selected.value) return
  void removeCustomSample(selected.value.id, sample.id)
}

// ---------------------------------------------------------------- 依次试听全部采样
// 点击任意采样行的 ▶，都会把当前这套音源（乐器）的所有采样依次播一遍，
// 方便一次听完自己拼好的整套音色；连播中再次点击即中断。

/** 正在试听的采样 key（用于按钮上的播放状态反馈） */
const auditioningKey = ref('')
/** 是否正在依次试听当前音源的全部采样 */
const playingSamples = ref(false)
/** 连播代号：自增即可让上一轮循环自行退出 */
let samplesRun = 0
/** 采样之间的间隔定时器句柄 */
let samplesTimer = 0

/** 等待指定毫秒（用于控制相邻两个采样的间隔） */
function waitSampleGap(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.clearTimeout(samplesTimer)
    samplesTimer = window.setTimeout(resolve, ms)
  })
}

/** 中断连播并收掉正在响的试听声音 */
function stopSamplePreview(): void {
  samplesRun += 1
  playingSamples.value = false
  auditioningKey.value = ''
  window.clearTimeout(samplesTimer)
  stopInstrumentPreview()
}

/**
 * 依次试听当前音源的全部采样。
 * 每个采样按自身长度原速播完（鼓组按绑定音号、旋律按原始音高），
 * 再留一点间隔切下一个，避免多个采样的尾巴叠在一起。
 */
async function onPreviewSamples(): Promise<void> {
  const instrument = selected.value
  if (!instrument || instrument.samples.length === 0) return
  if (playingSamples.value) {
    stopSamplePreview()
    return
  }
  playingSamples.value = true
  const run = ++samplesRun
  for (const sample of instrument.samples) {
    if (run !== samplesRun) return
    auditioningKey.value = sample.key
    await previewCustomSample(sample.key)
    await waitSampleGap(Math.max(400, sample.duration * 1000) + 220)
  }
  if (run === samplesRun) {
    playingSamples.value = false
    auditioningKey.value = ''
  }
}

onBeforeUnmount(() => {
  stopSamplePreview()
})

// 切换到另一套音源时，立刻中断上一套的连播，避免声音继续往后播
watch(selectedId, () => {
  if (playingSamples.value) stopSamplePreview()
})

function onRemoveInstrument(): void {
  const instrument = selected.value
  if (!instrument) return
  const used = trackCountOf(instrument.id)
  const warn = used
    ? `确定删除自定义音源「${instrument.name}」？有 ${used} 条轨道正在使用它，会被回退为内置钢琴。`
    : `确定删除自定义音源「${instrument.name}」？`
  if (!window.confirm(warn)) return
  void removeCustomInstrument(instrument.id)
}
</script>

<template>
  <div class="panel">
    <!-- 左：音源列表 + 新建 -->
    <aside class="list-col">
      <div class="new-box">
        <input
          v-model="newName"
          class="new-name"
          placeholder="新音源名称"
          title="自定义音源名称"
          @keydown.enter="onCreate"
        />
        <select v-model="newKind" class="new-kind" title="音源类型">
          <option v-for="opt in kindOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <button class="primary block" title="新建自定义音源" @click="onCreate">＋ 新建音源</button>
      </div>

      <div class="list">
        <TransitionGroup name="list-pop">
          <button
            v-for="ci in instruments"
            :key="ci.id"
            class="item"
            :class="{ active: ci.id === selectedId }"
            @click="selectedId = ci.id"
          >
            <span class="item-name">{{ ci.name }}</span>
            <span class="item-meta">
              {{ ci.kind === 'drum' ? '鼓组' : '旋律' }} · {{ ci.samples.length }} 采样
            </span>
          </button>
        </TransitionGroup>
        <p v-if="!instruments.length" class="empty">还没有自定义音源，先在上方新建一套。</p>
      </div>
    </aside>

    <!-- 右：选中音源的编辑器 -->
    <section class="edit-col">
      <Transition name="panel-swap" mode="out-in">
        <div v-if="selected" :key="selected.id" class="edit-inner">
          <div class="field">
            <span class="label">名称</span>
            <input class="grow" :value="selected.name" title="音源名称" @change="onRename" />
          </div>

          <div class="field">
            <span class="label">类型</span>
            <select class="grow" :value="selected.kind" @change="onKindChange">
              <option v-for="opt in kindOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </div>
          <p class="hint">{{ kindDesc(selected.kind) }}</p>

          <div class="field">
            <span class="label">整体增益</span>
            <input
              class="grow"
              type="range"
              min="0"
              max="2"
              step="0.01"
              :value="selected.gain"
              @input="onGainInput"
            />
            <span class="value">{{ Math.round(selected.gain * 100) }}%</span>
          </div>

          <div class="samples-head">
            <span class="samples-title">采样（{{ selected.samples.length }}）</span>
            <button class="primary" title="导入音频文件作为采样" @click="onPickFile">＋ 添加采样</button>
            <input
              ref="fileInput"
              type="file"
              accept="audio/*"
              multiple
              class="hidden-file"
              @change="onFileChange"
            />
          </div>

          <div class="samples">
            <TransitionGroup name="list-pop">
              <div v-for="sample in selected.samples" :key="sample.id" class="sample">
                <div class="sample-top">
                  <input
                    class="sample-name"
                    :value="sample.name"
                    title="采样名称"
                    @change="onSampleName($event, sample)"
                  />
                  <span class="sample-dur">{{ sample.duration.toFixed(2) }}s</span>
                  <button
                    class="mini"
                    :class="{ playing: auditioningKey === sample.key }"
                    :title="playingSamples ? '停止依次试听' : '依次试听这套音源的全部采样'"
                    @click="onPreviewSamples"
                  >
                    ▶
                  </button>
                  <button class="mini danger" title="删除采样" @click="onRemoveSample(sample)">✕</button>
                </div>

                <div class="sample-line">
                  <template v-if="selected.kind === 'drum'">
                    <span class="sub-label">音号</span>
                    <select
                      class="grow"
                      :value="sample.midi"
                      title="该采样对应的 GM 鼓件音号"
                      @change="onSampleMidi($event, sample)"
                    >
                      <option v-for="note in GM_DRUM_NOTES" :key="note.midi" :value="note.midi">
                        {{ note.midi }} · {{ note.label }}
                      </option>
                    </select>
                  </template>
                  <template v-else>
                    <span class="sub-label">原始音高</span>
                    <input
                      class="midi-num"
                      type="number"
                      min="0"
                      max="127"
                      :value="sample.rootMidi"
                      title="采样本身的 MIDI 音号，其它音高据此移调"
                      @change="onSampleRoot($event, sample)"
                    />
                    <span class="pitch">{{ samplePitchLabel(sample) }}</span>
                  </template>
                </div>

                <div class="sample-line">
                  <span class="sub-label">增益</span>
                  <input
                    class="grow"
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    :value="sample.gain"
                    @input="onSampleGain($event, sample)"
                  />
                  <span class="value">{{ Math.round(sample.gain * 100) }}%</span>
                </div>
              </div>
            </TransitionGroup>

            <p v-if="!selected.samples.length" class="empty">
              还没有采样，点「＋ 添加采样」导入音频文件（wav / mp3 / ogg 均可）。
            </p>
          </div>

          <div class="edit-foot">
            <button class="danger-btn" title="删除整套音源" @click="onRemoveInstrument">
              删除这套音源
            </button>
          </div>
        </div>

        <p v-else key="empty" class="empty placeholder">选择左侧的一套音源进行编辑，或新建一套。</p>
      </Transition>
    </section>
  </div>
</template>

<style scoped>
.panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
}

/* ---------------- 左栏：列表 + 新建 ---------------- */
.list-col {
  width: 210px;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}

.new-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}

.new-name,
.new-kind,
.block {
  width: 100%;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: none;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  transition: background 0.18s ease, box-shadow 0.18s ease, padding-left 0.18s ease;
}

.item:hover:not(.active) {
  background: var(--panel-2);
  padding-left: 14px;
}

.item.active {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}

.item-name {
  font-size: 12px;
  font-weight: 600;
}

.item-meta {
  font-size: 11px;
  color: var(--text-dim);
}

/* ---------------- 右栏：编辑器 ---------------- */
.edit-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 14px;
}

.edit-inner {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field {
  display: flex;
  align-items: center;
  gap: 8px;
}

.field .label {
  width: 62px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-dim);
}

.grow {
  flex: 1;
  min-width: 0;
}

.field .value {
  width: 42px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.5;
  font-style: italic;
}

.samples-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}

.samples-title {
  font-size: 12px;
  font-weight: 600;
}

.samples {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sample {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.sample:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-sm);
}

.sample-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sample-name {
  flex: 1;
  min-width: 0;
}

.sample-dur {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.mini {
  padding: 2px 7px;
  line-height: 1.1;
  font-size: 12px;
  flex: 0 0 auto;
}

/* 依次试听中的采样：按钮做成主题色激活态，方便看出当前播到哪一个 */
.mini.playing {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--accent), 0 2px 8px rgba(79, 157, 247, 0.35);
}

.danger:hover {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.sample-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-label {
  width: 62px;
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-dim);
}

.midi-num {
  width: 62px;
  flex: 0 0 auto;
}

.pitch {
  font-size: 11px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.sample-line .value {
  width: 42px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.edit-foot {
  margin-top: 8px;
  padding-top: 10px;
  display: flex;
  justify-content: flex-end;
}

.danger-btn {
  color: var(--accent-2);
  border-color: var(--accent-2);
  font-size: 12px;
}

.empty {
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
  padding: 10px 2px;
}

.placeholder {
  margin: auto;
  text-align: center;
}

.hidden-file {
  display: none;
}

.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
  padding: 5px 16px;
  flex: 0 0 auto;
}

.primary:hover {
  background: #6ab4ff;
  border-color: #6ab4ff;
}
</style>
