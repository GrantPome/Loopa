<script setup lang="ts">
/**
 * 效果器面板（默认位于左栏，紧邻轨道列表）
 *
 * 展示「当前选中轨道」的插入式效果器链：
 *   添加 / 启用停用 / 上下排序 / 移除 / 参数调节 / 重置
 * 参数控件按效果器定义（EFFECT_DEFS）自动生成，
 * 以后新增效果器类型时只需补充定义，界面代码无需改动。
 */
import { computed, ref } from 'vue'
import type { EffectType, TrackEffect } from '@/types'
import { EFFECT_DEFS, EFFECT_DEF_MAP } from '@/types'
import {
  activeTrack,
  addEffect,
  clearEffects,
  moveEffect,
  removeEffect,
  resetEffect,
  setEffectParam,
  setEffectSidechain,
  state,
  toggleEffect
} from '@/core/store'

const newType = ref<EffectType>('compressor')
/** 当前展开参数的效果器 id（同时只展开一个，保持左栏紧凑） */
const expandedId = ref('')

const track = computed(() => activeTrack())
const effects = computed(() => track.value?.effects ?? [])

/** 添加效果器，并自动展开它的参数区，方便立刻调参 */
function onAdd(): void {
  const current = track.value
  if (!current) return
  addEffect(current.id, newType.value)
  expandedId.value = current.effects[current.effects.length - 1]?.id ?? ''
}

function onToggle(effect: TrackEffect): void {
  if (track.value) toggleEffect(track.value.id, effect.id)
}

function onMove(effect: TrackEffect, dir: -1 | 1): void {
  if (track.value) moveEffect(track.value.id, effect.id, dir)
}

function onRemove(effect: TrackEffect): void {
  if (track.value) removeEffect(track.value.id, effect.id)
}

function onReset(effect: TrackEffect): void {
  if (track.value) resetEffect(track.value.id, effect.id)
}

function onClear(): void {
  if (track.value) clearEffects(track.value.id)
}

function onParamInput(effect: TrackEffect, key: string, event: Event): void {
  const current = track.value
  if (!current) return
  setEffectParam(current.id, effect.id, key, Number((event.target as HTMLInputElement).value))
}

function onModeChange(effect: TrackEffect, event: Event): void {
  const current = track.value
  if (!current) return
  setEffectParam(current.id, effect.id, 'mode', Number((event.target as HTMLSelectElement).value))
}

/** 侧链触发源候选：当前轨以外的全部轨道（用它们的电平去压低本轨增益） */
const sidechainSources = computed(() =>
  state.project.tracks.filter((t) => t.id !== track.value?.id)
)

/** 侧链衰减量的显示读数（默认值 12dB，与引擎侧默认一致） */
function sidechainAmountText(effect: TrackEffect): string {
  return `${Math.round(effect.sidechain?.amount ?? 12)}dB`
}

/** 侧链恢复时间的显示读数 */
function sidechainReleaseText(effect: TrackEffect): string {
  return `${(effect.sidechain?.release ?? 0.2).toFixed(2)}s`
}

/** 选择侧链触发源：选「关闭」时清除侧链配置 */
function onSidechainSource(effect: TrackEffect, event: Event): void {
  const current = track.value
  if (!current) return
  const source = (event.target as HTMLSelectElement).value
  setEffectSidechain(
    current.id,
    effect.id,
    source,
    effect.sidechain?.amount ?? 12,
    effect.sidechain?.release ?? 0.2
  )
}

/** 调整侧链衰减量（dB） */
function onSidechainAmount(effect: TrackEffect, event: Event): void {
  const current = track.value
  const sc = effect.sidechain
  if (!current || !sc) return
  setEffectSidechain(current.id, effect.id, sc.sourceTrackId, Number((event.target as HTMLInputElement).value), sc.release)
}

/** 调整侧链恢复时间（秒） */
function onSidechainRelease(effect: TrackEffect, event: Event): void {
  const current = track.value
  const sc = effect.sidechain
  if (!current || !sc) return
  setEffectSidechain(current.id, effect.id, sc.sourceTrackId, sc.amount, Number((event.target as HTMLInputElement).value))
}

/** 数值读数：带单位，并按步长决定小数位数 */
function displayValue(effect: TrackEffect, key: string): string {
  const def = EFFECT_DEF_MAP[effect.type].params.find((p) => p.key === key)
  const value = effect.params[key] ?? 0
  if (!def) return String(value)
  if (key === 'mode') return value >= 0.5 ? '高通' : '低通'
  const rounded = def.step >= 1 ? Math.round(value) : Math.round(value * 100) / 100
  return `${rounded}${def.unit ?? ''}`
}

function toggleExpand(effect: TrackEffect): void {
  expandedId.value = expandedId.value === effect.id ? '' : effect.id
}
</script>

<template>
  <aside class="fx-panel">
    <div class="head">
      <span class="title">效果器</span>
      <span class="spacer" />
      <button class="mini" :disabled="!track || effects.length === 0" title="清空当前轨道的全部效果器" @click="onClear">
        清空
      </button>
    </div>

    <div class="add-row">
      <select v-model="newType" :disabled="!track" title="选择要添加的效果器">
        <option v-for="def in EFFECT_DEFS" :key="def.type" :value="def.type">{{ def.label }}</option>
      </select>
      <button :disabled="!track" title="把效果器添加到当前轨道的效果器链末尾" @click="onAdd">＋</button>
    </div>

    <div class="list">
      <p v-if="!track" class="empty">请先在轨道列表里选中一条轨道</p>
      <p v-else-if="effects.length === 0" class="empty">当前轨道还没有效果器，选一种后点「＋」添加</p>

      <template v-else>
        <div
          v-for="(effect, index) in effects"
          :key="effect.id"
          class="fx-card"
          :class="{ off: !effect.enabled, expanded: expandedId === effect.id }"
        >
          <div class="fx-head" :title="EFFECT_DEF_MAP[effect.type].desc" @click="toggleExpand(effect)">
            <button
              class="power"
              :class="{ on: effect.enabled }"
              :title="effect.enabled ? '点击停用' : '点击启用'"
              @click.stop="onToggle(effect)"
            >
              ⏻
            </button>
            <span class="fx-name">{{ EFFECT_DEF_MAP[effect.type].label }}</span>
            <span class="spacer" />
            <button class="mini" :disabled="index === 0" title="上移" @click.stop="onMove(effect, -1)">↑</button>
            <button class="mini" :disabled="index === effects.length - 1" title="下移" @click.stop="onMove(effect, 1)">↓</button>
            <button class="mini danger" title="移除" @click.stop="onRemove(effect)">✕</button>
          </div>

          <div v-if="expandedId === effect.id" class="fx-body">
            <p class="desc">{{ EFFECT_DEF_MAP[effect.type].desc }}</p>
            <div v-for="def in EFFECT_DEF_MAP[effect.type].params" :key="def.key" class="param">
              <span class="label">{{ def.label }}</span>
              <select
                v-if="def.key === 'mode'"
                :value="String(effect.params[def.key] ?? 0)"
                @change="onModeChange(effect, $event)"
              >
                <option value="0">低通</option>
                <option value="1">高通</option>
              </select>
              <input
                v-else
                type="range"
                :min="def.min"
                :max="def.max"
                :step="def.step"
                :value="effect.params[def.key]"
                :title="`${def.label} ${def.min}~${def.max}${def.unit ?? ''}`"
                @input="onParamInput(effect, def.key, $event)"
              />
              <span class="value">{{ displayValue(effect, def.key) }}</span>
            </div>

            <!-- 侧链：用另一条轨道的电平压低本轨增益，实现「底鼓一响，铺底让路」 -->
            <div v-if="effect.type === 'compressor'" class="sidechain">
              <div class="param">
                <span class="label">侧链源</span>
                <select
                  :value="effect.sidechain?.sourceTrackId ?? ''"
                  title="选择用来触发衰减的轨道，选「关闭」即停用侧链"
                  @change="onSidechainSource(effect, $event)"
                >
                  <option value="">关闭</option>
                  <option v-for="t in sidechainSources" :key="t.id" :value="t.id">{{ t.name }}</option>
                </select>
                <span class="value" />
              </div>
              <template v-if="effect.sidechain">
                <div class="param">
                  <span class="label">衰减量</span>
                  <input
                    type="range"
                    min="0"
                    max="48"
                    step="1"
                    :value="effect.sidechain.amount"
                    title="侧链最大衰减量 0~48dB"
                    @input="onSidechainAmount(effect, $event)"
                  />
                  <span class="value">{{ sidechainAmountText(effect) }}</span>
                </div>
                <div class="param">
                  <span class="label">恢复</span>
                  <input
                    type="range"
                    min="0.01"
                    max="2"
                    step="0.01"
                    :value="effect.sidechain.release"
                    title="衰减后的恢复时间 0.01~2s"
                    @input="onSidechainRelease(effect, $event)"
                  />
                  <span class="value">{{ sidechainReleaseText(effect) }}</span>
                </div>
              </template>
            </div>

            <button class="reset" @click="onReset(effect)">重置参数</button>
          </div>
        </div>
      </template>
    </div>

    <p class="foot">信号链：乐器 / 波形 → 效果器 → 均衡 → 声像 → 推子 → 总线</p>
  </aside>
</template>

<style scoped>
.fx-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-top: 1px solid var(--line);
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

.spacer {
  flex: 1;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--line);
}

.add-row select {
  flex: 1;
  min-width: 0;
}

.list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 6px;
}

.empty {
  color: var(--text-dim);
  padding: 10px 6px;
  line-height: 1.6;
  margin: 0;
}

.fx-card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel-2);
  margin-bottom: 6px;
  overflow: hidden;
}

.fx-card.off {
  opacity: 0.55;
}

.fx-card.expanded {
  border-color: var(--accent);
}

.fx-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  cursor: pointer;
  user-select: none;
}

.fx-head:hover {
  background: var(--panel-3);
}

.power {
  width: 22px;
  padding: 1px 0;
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
  color: var(--text-dim);
}

.power.on {
  color: #10231a;
  background: var(--ok);
  border-color: var(--ok);
}

.fx-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.mini {
  padding: 1px 5px;
  font-size: 11px;
  line-height: 1.2;
}

.mini:disabled {
  opacity: 0.35;
}

.danger:hover:not(:disabled) {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.fx-body {
  padding: 6px 8px 8px;
  border-top: 1px solid var(--line);
}

.desc {
  margin: 0 0 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
}

.param {
  display: flex;
  align-items: center;
  gap: 5px;
}

.param + .param {
  margin-top: 4px;
}

.param .label {
  width: 52px;
  font-size: 11px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.param input[type='range'],
.param select {
  flex: 1;
  min-width: 0;
}

.param .value {
  width: 46px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

/* 侧链配置区：与普通参数用虚线分隔，避免误认为是压缩器自带参数 */
.sidechain {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.reset {
  margin-top: 8px;
  width: 100%;
  font-size: 11px;
  padding: 3px 0;
}

.foot {
  margin: 0;
  padding: 6px 10px;
  border-top: 1px solid var(--line);
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim);
}
</style>
