<script setup lang="ts">
/**
 * 波形编辑器（音频轨专用）
 *
 * 展示当前音频片段的完整源波形，并允许对片段做「修剪」：
 *   · 拖动左边缘 → 从头部裁剪（片段在时间轴上的起点同步后移，保持右端不动）
 *   · 拖动右边缘 → 从尾部裁剪
 *   · 在波形上单击 → 把播放头定位到对应位置
 * 另外提供片段增益与淡入淡出调节。
 *
 * 波形用降采样峰值绘制（peaks 保存在工程 JSON 里），
 * 因此这里不需要读取 IndexedDB 里的原始采样，缩放与滚动都很轻量。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  activeClip,
  activeTrack,
  duplicateClip,
  isClipPlayable,
  previewActiveClip,
  removeClip,
  renameClip,
  resizeClip,
  selectAudioClip,
  setClipFade,
  setClipGain,
  splitClip,
  seek,
  state
} from '@/core/store'
import { peakRange } from '@/utils/waveform'
import { clamp } from '@/utils/music'
import { hexToRgba } from '@/utils/color'

const wrapEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
/** 光标样式：靠近修剪手柄时切换为左右箭头 */
const cursor = ref('crosshair')

const track = computed(() => {
  const t = activeTrack()
  return t && t.kind === 'audio' ? t : undefined
})
const clip = computed(() => activeClip())
const clips = computed(() => track.value?.clips ?? [])
/** 每拍秒数：把「拍」换算成波形需要的时间轴秒数 */
const secondsPerBeat = computed(() => 60 / state.project.bpm)
/** 片段在源音频中的使用长度（秒） */
const usedSeconds = computed(() => (clip.value ? clip.value.duration * secondsPerBeat.value : 0))
const playable = computed(() => (clip.value ? isClipPlayable(clip.value) : false))
/** 播放头是否落在片段区间内 */
const playheadInClip = computed(() => {
  const c = clip.value
  if (!c) return false
  return state.playheadBeats >= c.start && state.playheadBeats <= c.start + c.duration
})

let rafId = 0
let dirty = true
/** 当前拖动的手柄：'' 表示未拖动 */
let dragging: 'left' | 'right' | '' = ''

function requestDraw(): void {
  dirty = true
}

// ---------------------------------------------------------------- 绘制

/** 计算修剪手柄在画布上的 x 坐标 */
function handlePositions(): { left: number; right: number; width: number } {
  const canvas = canvasEl.value
  const c = clip.value
  const width = canvas?.clientWidth ?? 0
  if (!c || c.sourceDuration <= 0 || width <= 0) return { left: 0, right: width, width }
  const left = (c.offset / c.sourceDuration) * width
  const right = ((c.offset + usedSeconds.value) / c.sourceDuration) * width
  return { left, right, width }
}

function draw(): void {
  const canvas = canvasEl.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width <= 0 || height <= 0) return
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  // 背景
  ctx.fillStyle = '#1a1c22'
  ctx.fillRect(0, 0, width, height)

  const c = clip.value
  const t = track.value
  if (!c || !t) return

  const peaks = c.peaks
  const buckets = Math.floor(peaks.length / 2)
  const mid = height / 2
  const amp = mid * 0.92
  const { left: x0, right: x1 } = handlePositions()

  // 中线
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(0, Math.round(mid), width, 1)

  // ---------- 波形（整段源音频） ----------
  if (buckets > 0) {
    ctx.fillStyle = t.color
    for (let x = 0; x < width; x += 1) {
      const { min, max } = peakRange(peaks, x / width, (x + 1) / width, buckets)
      const top = mid - max * amp
      const bottom = mid - min * amp
      ctx.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.font = '12px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('该片段暂无波形数据', width / 2, mid)
  }

  // ---------- 未被使用的区域压暗 ----------
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  if (x0 > 0) ctx.fillRect(0, 0, x0, height)
  if (x1 < width) ctx.fillRect(x1, 0, width - x1, height)

  // ---------- 淡入 / 淡出示意（斜线三角） ----------
  const fadeInX = x0 + (c.fadeIn * secondsPerBeat.value / Math.max(0.0001, c.sourceDuration)) * width
  const fadeOutX = x1 - (c.fadeOut * secondsPerBeat.value / Math.max(0.0001, c.sourceDuration)) * width
  ctx.strokeStyle = hexToRgba('#ffffff', 0.35)
  ctx.lineWidth = 1
  if (c.fadeIn > 0) {
    ctx.beginPath()
    ctx.moveTo(x0, height - 2)
    ctx.lineTo(fadeInX, 2)
    ctx.stroke()
  }
  if (c.fadeOut > 0) {
    ctx.beginPath()
    ctx.moveTo(fadeOutX, 2)
    ctx.lineTo(x1, height - 2)
    ctx.stroke()
  }

  // ---------- 使用区间边框 ----------
  ctx.strokeStyle = '#4f9df7'
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.max(1, Math.round(x1 - x0) - 1), height - 1)

  // ---------- 修剪手柄 ----------
  ctx.fillStyle = '#4f9df7'
  ctx.fillRect(Math.round(x0) - 2, 0, 4, height)
  ctx.fillRect(Math.round(x1) - 2, 0, 4, height)

  // ---------- 播放头 ----------
  if (playheadInClip.value) {
    const local = state.playheadBeats - c.start
    const px = x0 + (local * secondsPerBeat.value / Math.max(0.0001, c.sourceDuration)) * width
    ctx.fillStyle = '#ff4d6d'
    ctx.fillRect(Math.round(px), 0, 2, height)
  }
}

function loop(): void {
  if (dirty || state.isPlaying) {
    draw()
    dirty = false
  }
  rafId = requestAnimationFrame(loop)
}

// ---------------------------------------------------------------- 交互

function xAt(event: PointerEvent): number {
  const canvas = canvasEl.value
  if (!canvas) return 0
  const rect = canvas.getBoundingClientRect()
  return clamp(event.clientX - rect.left, 0, rect.width)
}

function onPointerDown(event: PointerEvent): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  event.preventDefault()
  const x = xAt(event)
  const { left, right } = handlePositions()
  // 命中手柄（±8px）→ 进入修剪模式，否则把播放头定位到点击位置
  if (Math.abs(x - left) <= 8) {
    dragging = 'left'
  } else if (Math.abs(x - right) <= 8) {
    dragging = 'right'
  } else {
    const localSec = (x / (canvasEl.value?.clientWidth || 1)) * c.sourceDuration
    const beat = c.start + (localSec - c.offset) / secondsPerBeat.value
    seek(clamp(beat, c.start, c.start + c.duration))
    return
  }
  canvasEl.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  const x = xAt(event)

  if (!dragging) {
    // 悬停时给出可拖拽的光标提示
    const { left, right } = handlePositions()
    cursor.value = Math.abs(x - left) <= 8 || Math.abs(x - right) <= 8 ? 'ew-resize' : 'crosshair'
    return
  }

  const width = canvasEl.value?.clientWidth || 1
  const spb = secondsPerBeat.value
  const minBeats = 0.125

  if (dragging === 'left') {
    // 从头部裁剪：右端保持不动，起点与偏移同步后移
    const endSec = c.offset + c.duration * spb
    const nextOffset = clamp((x / width) * c.sourceDuration, 0, Math.max(0, endSec - minBeats * spb))
    const deltaBeats = (nextOffset - c.offset) / spb
    resizeClip(t.id, c.id, {
      offset: nextOffset,
      start: c.start + deltaBeats,
      duration: c.duration - deltaBeats
    })
  } else {
    // 从尾部裁剪：起点与偏移保持不动，只改时长
    const nextEnd = clamp((x / width) * c.sourceDuration, c.offset + minBeats * spb, c.sourceDuration)
    resizeClip(t.id, c.id, { duration: (nextEnd - c.offset) / spb })
  }
  requestDraw()
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging) return
  dragging = ''
  const canvas = canvasEl.value
  if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
}

// ---------------------------------------------------------------- 操作

function onClipChange(event: Event): void {
  const t = track.value
  if (!t) return
  selectAudioClip(t.id, (event.target as HTMLSelectElement).value)
}

function onRename(event: Event): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  renameClip(t.id, c.id, (event.target as HTMLInputElement).value.trim())
}

function onGainInput(event: Event): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  setClipGain(t.id, c.id, Number((event.target as HTMLInputElement).value))
}

function onFadeInput(edge: 'in' | 'out', event: Event): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  setClipFade(t.id, c.id, edge, Number((event.target as HTMLInputElement).value))
}

function onSplit(): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  splitClip(t.id, c.id, state.playheadBeats)
}

function onDuplicate(): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  duplicateClip(t.id, c.id)
}

function onRemove(): void {
  const c = clip.value
  const t = track.value
  if (!c || !t) return
  removeClip(t.id, c.id)
}

// ---------------------------------------------------------------- 生命周期

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  rafId = requestAnimationFrame(loop)
  if (wrapEl.value) {
    resizeObserver = new ResizeObserver(() => requestDraw())
    resizeObserver.observe(wrapEl.value)
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
})

watch(
  () => [state.revision, state.playheadBeats, state.selectedClipId, state.viewMode],
  () => requestDraw()
)
</script>

<template>
  <div class="audio-editor">
    <!-- 顶部操作条 -->
    <div class="head">
      <span v-if="track" class="dot" :style="{ background: track.color }" />
      <span class="name" :title="track?.name">{{ track?.name || '未选择音频轨' }}</span>

      <select v-if="clips.length > 1" :value="clip?.id" title="切换片段" @change="onClipChange">
        <option v-for="item in clips" :key="item.id" :value="item.id">{{ item.name }}</option>
      </select>
      <input
        v-else-if="clip"
        class="clip-name"
        :value="clip.name"
        title="片段名称（可修改）"
        @change="onRename"
      />

      <span class="spacer" />

      <button :disabled="!clip" title="试听当前片段" @click="previewActiveClip()">试听</button>
      <button :disabled="!clip" title="在播放头位置把片段一分为二" @click="onSplit">拆分</button>
      <button :disabled="!clip" title="在当前片段末尾复制一份" @click="onDuplicate">复制</button>
      <button class="danger" :disabled="!clip" title="删除片段" @click="onRemove">删除</button>
    </div>

    <!-- 波形区 -->
    <div ref="wrapEl" class="wave-wrap">
      <canvas
        ref="canvasEl"
        :style="{ cursor }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointerleave="onPointerUp"
      />
      <p v-if="!track" class="empty">当前没有选中音频轨。在左侧轨道面板点「＋音频轨」新增，或用「导入音频」载入波形。</p>
      <p v-else-if="!clip" class="empty">这条音频轨还没有片段。点工具栏「录音」直接录制，或用「导入音频」载入文件。</p>
      <span v-else-if="!playable" class="loading">采样加载中…</span>
    </div>

    <!-- 片段参数 -->
    <div v-if="clip" class="controls">
      <label class="ctrl">
        <span class="label">增益</span>
        <input
          type="range"
          min="0"
          max="2"
          step="0.01"
          :value="clip.gain"
          title="片段增益 0~2（1 为原始音量）"
          @input="onGainInput"
        />
        <span class="value">{{ Math.round(clip.gain * 100) }}%</span>
      </label>

      <label class="ctrl">
        <span class="label">淡入</span>
        <input
          type="range"
          min="0"
          :max="clip.duration"
          step="0.0625"
          :value="clip.fadeIn"
          title="淡入时长（拍）"
          @input="onFadeInput('in', $event)"
        />
        <span class="value">{{ clip.fadeIn.toFixed(2) }}</span>
      </label>

      <label class="ctrl">
        <span class="label">淡出</span>
        <input
          type="range"
          min="0"
          :max="clip.duration"
          step="0.0625"
          :value="clip.fadeOut"
          title="淡出时长（拍）"
          @input="onFadeInput('out', $event)"
        />
        <span class="value">{{ clip.fadeOut.toFixed(2) }}</span>
      </label>

      <span class="info">
        源 {{ clip.sourceDuration.toFixed(2) }}s · 已用 {{ usedSeconds.toFixed(2) }}s ·
        {{ clip.sampleRate }}Hz · 起点第 {{ Math.floor(clip.start) + 1 }} 拍
      </span>
    </div>
  </div>
</template>

<style scoped>
.audio-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  row-gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}

.name {
  font-weight: 600;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clip-name {
  width: 140px;
}

.spacer {
  flex: 1;
}

.danger:hover:not(:disabled) {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.wave-wrap {
  position: relative;
  flex: 1;
  min-height: 120px;
  min-width: 0;
  padding: 8px 10px;
}

.wave-wrap canvas {
  display: block;
  width: 100%;
  height: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  touch-action: none;
}

.empty {
  position: absolute;
  inset: 8px 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-dim);
  line-height: 1.7;
  padding: 0 24px;
  margin: 0;
}

.loading {
  position: absolute;
  top: 14px;
  right: 16px;
  font-size: 11px;
  color: var(--accent-2);
}

.controls {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  row-gap: 6px;
  padding: 8px 10px;
  background: var(--panel);
  border-top: 1px solid var(--line);
}

.ctrl {
  display: flex;
  align-items: center;
  gap: 5px;
}

.ctrl .label {
  font-size: 11px;
  color: var(--text-dim);
  flex: 0 0 auto;
}

.ctrl input[type='range'] {
  width: 110px;
}

.ctrl .value {
  width: 46px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.info {
  font-size: 11px;
  color: var(--text-dim);
  margin-left: auto;
}
</style>
