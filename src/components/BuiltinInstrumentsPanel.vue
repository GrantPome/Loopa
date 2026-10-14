<script setup lang="ts">
/**
 * 内置乐器面板（「乐器与音源」管理器的第一个页签）
 *
 * - 左侧按「旋律乐器 / 鼓组」分组列出全部内置音色，每项可单独试听
 * - 右侧展示所选音色的说明、试听按钮、鼓件映射与正在使用它的轨道
 * - 支持把音色一键应用到当前选中的 MIDI 轨道
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { InstrumentType } from '@/types'
import { GM_DRUM_NOTES, INSTRUMENT_LABELS } from '@/types'
import { applyInstrumentToActiveTrack, previewInstrument, selectTrack, state } from '@/core/store'

/** 旋律类音色（与 types 中的 INSTRUMENT_OPTIONS 顺序一致） */
const MELODIC_TYPES: InstrumentType[] = [
  'piano',
  'electricPiano',
  'organ',
  'guitar',
  'bass',
  'strings',
  'brass',
  'flute',
  'bell',
  'pad',
  'synthLead'
]

/** 鼓组类音色 */
const DRUM_TYPES: InstrumentType[] = ['drums', 'electroDrums']

const GROUPS: { id: string; label: string; types: InstrumentType[] }[] = [
  { id: 'melodic', label: '旋律乐器', types: MELODIC_TYPES },
  { id: 'drum', label: '鼓组', types: DRUM_TYPES }
]

/** 各音色的简短说明（帮助用户按听感挑音色） */
const DESCS: Record<string, string> = {
  piano: '三角波叠加，起音快、尾音自然，适合伴奏与主旋律。',
  electricPiano: 'FM 合成，清亮带一点金属感，流行与爵士里的常客。',
  organ: '方波谐波叠加，延音绵长，适合铺底与长和弦。',
  guitar: '锯齿波配滤波包络，模拟拨弦的弹拨感。',
  bass: '低频锯齿 + 低通滤波，厚实有力，负责低音声部。',
  strings: '多层锯齿叠加，群奏感强，适合长音铺底。',
  brass: '锯齿波配中等起音，中高频的金属感突出。',
  flute: '纯净正弦 + 慢起音，几乎没有谐波，音色通透。',
  bell: '高调制指数 FM，泛音丰富，尾音悠长。',
  pad: '多层正弦 + 极慢起音，用于铺满背景。',
  synthLead: '多层锯齿 + 高 Q 滤波，旋律线条突出。',
  drums: '合成鼓组，按 GM 音号映射底鼓、军鼓、踩镲、通鼓与各类镲片。',
  electroDrums: '电子鼓组，映射与鼓组完全一致，音头更紧、尾巴更短。'
}

/** 试听示范乐句的说明 */
const DEMO_MELODIC = '示范：C4 → E4 → G4 → C5 上行分解和弦'
const DEMO_DRUM = '示范：底鼓 → 军鼓 → 闭合踩镲 → 开镲 → 吊镲'

const selected = ref<InstrumentType>('piano')
const isDrumSelected = computed(() => DRUM_TYPES.includes(selected.value))

/** 统计使用某音色的 MIDI 轨道 */
function tracksUsing(type: InstrumentType): typeof state.project.tracks {
  return state.project.tracks.filter((t) => t.kind === 'midi' && t.instrument === type)
}

const usage = computed(() => tracksUsing(selected.value))

/** 当前选中的轨道（用于「应用到当前轨道」） */
const targetTrack = computed(() => state.project.tracks.find((t) => t.id === state.selectedTrackId))
const canApply = computed(
  () => targetTrack.value?.kind === 'midi' && targetTrack.value.instrument !== selected.value
)

// ---------------------------------------------------------------- 试听

/** 正在试听的音色（用于按钮上的播放状态反馈） */
const auditioning = ref<InstrumentType | null>(null)
let auditionTimer = 0

/** 试听指定音色；试听期间按钮显示为播放中 */
async function onPreview(type: InstrumentType = selected.value): Promise<void> {
  auditioning.value = type
  await previewInstrument(type)
  window.clearTimeout(auditionTimer)
  auditionTimer = window.setTimeout(() => {
    if (auditioning.value === type) auditioning.value = null
  }, 2200)
}

onBeforeUnmount(() => window.clearTimeout(auditionTimer))

/** 把当前音色应用到选中的 MIDI 轨道 */
function onApply(): void {
  if (!applyInstrumentToActiveTrack(selected.value)) return
  state.statusText = `已把「${INSTRUMENT_LABELS[selected.value]}」应用到 ${targetTrack.value?.name ?? '当前轨道'}`
}

/** 跳到使用该音色的某条轨道 */
function onJumpTrack(id: string): void {
  selectTrack(id)
}
</script>

<template>
  <div class="panel">
    <!-- 左：按分组列出全部内置音色 -->
    <aside class="list-col">
      <div class="list">
        <div v-for="group in GROUPS" :key="group.id" class="group">
          <div class="group-title">{{ group.label }}</div>
          <button
            v-for="type in group.types"
            :key="type"
            class="item"
            :class="{ active: type === selected }"
            @click="selected = type"
          >
            <span class="item-name">{{ INSTRUMENT_LABELS[type] }}</span>
            <span class="item-usage">{{ tracksUsing(type).length }} 轨在用</span>
            <span
              class="item-play"
              :class="{ playing: auditioning === type }"
              title="试听"
              @click.stop="onPreview(type)"
            >
              ▶
            </span>
          </button>
        </div>
      </div>
    </aside>

    <!-- 右：所选音色的详情 -->
    <section class="detail-col">
      <Transition name="panel-swap" mode="out-in">
        <div :key="selected" class="detail">
          <div class="title-row">
            <span class="detail-name">{{ INSTRUMENT_LABELS[selected] }}</span>
            <span class="chip">{{ isDrumSelected ? '鼓组' : '旋律乐器' }}</span>
          </div>

          <p class="desc">{{ DESCS[selected] }}</p>

          <div class="demo-row">
            <button
              class="primary preview-btn"
              :class="{ playing: auditioning === selected }"
              @click="onPreview()"
            >
              {{ auditioning === selected ? '♪ 试听中…' : '▶ 试听音色' }}
            </button>
            <span class="demo-text">{{ isDrumSelected ? DEMO_DRUM : DEMO_MELODIC }}</span>
          </div>

          <div class="apply-row">
            <button :disabled="!canApply" title="把该音色应用到当前选中的 MIDI 轨道" @click="onApply">
              应用到当前轨道
            </button>
            <span class="apply-hint">
              {{
                targetTrack?.kind === 'midi'
                  ? `当前轨道：${targetTrack.name}`
                  : '当前没有选中 MIDI 轨道'
              }}
            </span>
          </div>

          <!-- 鼓组：展示 GM 鼓件映射，方便对照自定义音源要补哪些采样 -->
          <template v-if="isDrumSelected">
            <div class="section-title">GM 鼓件映射（{{ GM_DRUM_NOTES.length }} 个音号）</div>
            <p class="hint">
              内置鼓组按下列音号发声；若想换成自己的采样（例如补上吊镲），可在「自定义音源」页签里导入。
            </p>
            <div class="drum-map">
              <span v-for="note in GM_DRUM_NOTES" :key="note.midi" class="drum-chip">
                <b>{{ note.midi }}</b>{{ note.label }}
              </span>
            </div>
          </template>

          <div class="section-title">使用中的轨道（{{ usage.length }}）</div>
          <div v-if="usage.length" class="usage">
            <button v-for="track in usage" :key="track.id" class="usage-item" @click="onJumpTrack(track.id)">
              <span class="dot" :style="{ background: track.color }" />
              {{ track.name }}
            </button>
          </div>
          <p v-else class="hint">暂时没有轨道使用这个音色。</p>
        </div>
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

/* ---------------- 左栏：分组列表 ---------------- */
.list-col {
  width: 210px;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.group-title {
  padding: 8px 10px 4px;
  font-size: 11px;
  color: var(--text-dim);
  letter-spacing: 0.04em;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
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
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}

.item-usage {
  font-size: 11px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.item-play {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 9px;
  color: var(--text-dim);
  transition: background 0.16s ease, color 0.16s ease, transform 0.16s ease;
}

.item-play:hover {
  background: var(--accent);
  color: #0d1117;
  transform: scale(1.12);
}

.item-play.playing {
  background: var(--accent);
  color: #0d1117;
  animation: play-pulse 0.9s ease-in-out infinite;
}

@keyframes play-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(79, 157, 247, 0.6);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(79, 157, 247, 0);
  }
}

/* ---------------- 右栏：详情 ---------------- */
.detail-col {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 14px;
}

.detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-name {
  font-size: 15px;
  font-weight: 600;
}

.chip {
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid var(--accent);
}

.desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.7;
}

.demo-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}

.preview-btn {
  min-width: 118px;
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.preview-btn.playing {
  box-shadow: 0 0 0 3px var(--accent-soft), 0 2px 10px rgba(79, 157, 247, 0.35);
}

.demo-text {
  font-size: 11px;
  color: var(--text-dim);
}

.apply-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}

.apply-hint {
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.6;
  font-style: italic;
}

/* 鼓件映射：小方块平铺 */
.drum-map {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.drum-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  transition: border-color 0.18s ease, color 0.18s ease;
}

.drum-chip:hover {
  border-color: var(--accent);
  color: var(--text);
}

.drum-chip b {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/* 使用中的轨道 */
.usage {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.usage-item {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  background: transparent;
  border-color: transparent;
}

.usage-item:hover {
  background: var(--accent-soft);
  border-color: transparent;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
  padding: 5px 16px;
}

.primary:hover {
  background: #6ab4ff;
  border-color: #6ab4ff;
}
</style>
