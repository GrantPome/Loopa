<script setup lang="ts">
/**
 * 自定义音源管理对话框
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
import { computed, ref, watch } from 'vue'
import type { CustomInstrumentKind, CustomSample } from '@/types'
import { GM_DRUM_NOTES, drumNoteLabel } from '@/types'
import {
  addCustomInstrument,
  closeCustomSound,
  importCustomSampleFile,
  previewCustomSample,
  removeCustomInstrument,
  removeCustomSample,
  renameCustomInstrument,
  setCustomInstrumentGain,
  setCustomInstrumentKind,
  state,
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

// 对话框每次打开时自动选中第一套音源，避免右侧空白
watch(
  () => state.customSoundOpen,
  (open) => {
    if (!open) return
    if (!instruments.value.some((c) => c.id === selectedId.value)) {
      selectedId.value = instruments.value[0]?.id ?? ''
    }
  },
  { immediate: true }
)

// 选中的音源被删除后回退到第一套
watch(instruments, () => {
  if (!instruments.value.some((c) => c.id === selectedId.value)) {
    selectedId.value = instruments.value[0]?.id ?? ''
  }
})

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
  setCustomInstrumentKind(selected.value.id, (event.target as HTMLSelectElement).value as CustomInstrumentKind)
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

function onRemoveInstrument(): void {
  if (!selected.value) return
  const name = selected.value.name
  if (!window.confirm(`确定删除自定义音源「${name}」？引用它的轨道会回退为内置钢琴。`)) return
  void removeCustomInstrument(selected.value.id)
}

function onClose(): void {
  closeCustomSound()
}
</script>

<template>
  <div class="overlay" @click.self="onClose">
    <div class="dialog">
      <header class="head">
        <span class="title">自定义音源</span>
        <button class="close" title="关闭" @click="onClose">✕</button>
      </header>

      <div class="body">
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
            <button
              v-for="ci in instruments"
              :key="ci.id"
              class="item"
              :class="{ active: ci.id === selectedId }"
              @click="selectedId = ci.id"
            >
              <span class="item-name">{{ ci.name }}</span>
              <span class="item-meta">{{ ci.kind === 'drum' ? '鼓组' : '旋律' }} · {{ ci.samples.length }} 采样</span>
            </button>
            <p v-if="!instruments.length" class="empty">
              还没有自定义音源，先在左上角新建一套。
            </p>
          </div>
        </aside>

        <!-- 右：选中音源的编辑器 -->
        <section class="edit-col">
          <template v-if="selected">
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
              <div v-for="sample in selected.samples" :key="sample.id" class="sample">
                <div class="sample-top">
                  <input
                    class="sample-name"
                    :value="sample.name"
                    title="采样名称"
                    @change="onSampleName($event, sample)"
                  />
                  <span class="sample-dur">{{ sample.duration.toFixed(2) }}s</span>
                  <button class="mini" title="试听采样" @click="previewCustomSample(sample.key)">▶</button>
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

              <p v-if="!selected.samples.length" class="empty">
                还没有采样，点「＋ 添加采样」导入音频文件（wav / mp3 / ogg 均可）。
              </p>
            </div>

            <div class="edit-foot">
              <button class="danger-btn" title="删除整套音源" @click="onRemoveInstrument">
                删除这套音源
              </button>
            </div>
          </template>

          <p v-else class="empty placeholder">
            选择左侧的一套音源进行编辑，或新建一套。
          </p>
        </section>
      </div>

      <footer class="foot">
        <span class="tip">{{ state.statusText }}</span>
        <button class="primary" @click="onClose">完成</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.dialog {
  width: 680px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.title {
  font-weight: 600;
}

.close {
  padding: 2px 8px;
  font-size: 13px;
}

.body {
  flex: 1;
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

.new-name {
  width: 100%;
}

.new-kind {
  width: 100%;
}

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
  margin-top: auto;
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

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
}

.tip {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
