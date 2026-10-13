<script setup lang="ts">
/**
 * 时间总轨：小节标尺 + 各轨道片段(Region)概览 + 播放头
 * 横向滚动与钢琴卷帘联动（共享 state.view）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { state, seek } from '@/core/store'
import { beatsPerBarOf, clamp } from '@/utils/music'
import { hexToRgba } from '@/utils/color'
import { KEY_WIDTH, LANE_HEIGHT, MAX_RULER_LANES, RULER_HEIGHT, SCROLLBAR_SIZE } from '@/utils/layout'

const wrapEl = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

/** 展示的轨道行数（超出部分不绘制，避免总轨过高） */
const laneCount = computed(() => Math.min(state.project.tracks.length, MAX_RULER_LANES))
const height = computed(() => RULER_HEIGHT + laneCount.value * LANE_HEIGHT + 4)
const totalBeats = computed(
  () => state.project.bars * beatsPerBarOf(state.project.timeSignature)
)
const totalWidth = computed(() => Math.max(200, totalBeats.value * state.view.pxPerBeat))

let rafId = 0
let dirty = true
let dragging = false

function requestDraw(): void {
  dirty = true
}

function draw(): void {
  const canvas = canvasEl.value
  const wrap = wrapEl.value
  if (!canvas || !wrap) return

  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const cssHeight = canvas.clientHeight
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(cssHeight * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, cssHeight)

  const px = state.view.pxPerBeat
  const bpb = beatsPerBarOf(state.project.timeSignature)
  // 只绘制视口范围内的内容（性能优化）
  const viewL = wrap.scrollLeft
  const viewR = viewL + wrap.clientWidth
  const beatL = viewL / px
  const beatR = viewR / px

  // ---------- 标尺 ----------
  ctx.fillStyle = '#22242b'
  ctx.fillRect(viewL, 0, viewR - viewL, RULER_HEIGHT)

  const barFrom = Math.max(0, Math.floor(beatL / bpb))
  const barTo = Math.ceil(beatR / bpb)
  ctx.font = '10px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (let bar = barFrom; bar <= barTo; bar += 1) {
    const x = Math.floor(bar * bpb * px)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.32)'
    ctx.fillRect(x, 0, 1, RULER_HEIGHT)
    ctx.fillStyle = '#9aa0b2'
    ctx.fillText(String(bar + 1), x + 4, RULER_HEIGHT / 2)
    for (let beat = 1; beat < bpb; beat += 1) {
      const bx = Math.floor((bar * bpb + beat) * px)
      if (bx < viewL || bx > viewR) continue
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)'
      ctx.fillRect(bx, RULER_HEIGHT - 6, 1, 6)
    }
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.fillRect(viewL, RULER_HEIGHT - 1, viewR - viewL, 1)

  // ---------- 片段概览 ----------
  const tracks = state.project.tracks.slice(0, laneCount.value)
  tracks.forEach((track, index) => {
    const y = RULER_HEIGHT + index * LANE_HEIGHT
    ctx.fillStyle = index % 2 === 0 ? '#20222a' : '#1c1e24'
    ctx.fillRect(viewL, y, viewR - viewL, LANE_HEIGHT)

    const isActive = track.id === state.selectedTrackId
    for (const region of track.regions) {
      const x = region.start * px
      const regionWidth = region.length * px
      if (x + regionWidth < viewL || x > viewR) continue
      ctx.fillStyle = hexToRgba(track.color, isActive ? 0.3 : 0.14)
      ctx.fillRect(x, y + 2, regionWidth, LANE_HEIGHT - 4)

      // 片段内的音符位置用小竖条表示，直观反映编曲密度
      ctx.fillStyle = hexToRgba(track.color, isActive ? 1 : 0.6)
      for (const note of region.notes) {
        const noteBeat = region.start + note.start
        if (noteBeat > beatR || noteBeat + note.duration < beatL) continue
        ctx.fillRect(noteBeat * px, y + 5, Math.max(1.5, Math.min(note.duration * px, 5)), LANE_HEIGHT - 10)
      }
    }
  })

  // ---------- 循环区间标记 ----------
  if (state.loopOn) {
    const loopX = Math.floor(totalBeats.value * px)
    if (loopX >= viewL && loopX <= viewR) {
      ctx.fillStyle = 'rgba(79, 157, 247, 0.9)'
      ctx.fillRect(loopX - 1, 0, 2, cssHeight)
    }
  }

  // ---------- 播放头 ----------
  const playX = state.playheadBeats * px
  if (playX >= viewL - 6 && playX <= viewR + 6) {
    ctx.fillStyle = '#ff4d6d'
    ctx.fillRect(Math.floor(playX), 0, 2, cssHeight)
    ctx.beginPath()
    ctx.moveTo(playX - 5, 0)
    ctx.lineTo(playX + 5, 0)
    ctx.lineTo(playX, 8)
    ctx.closePath()
    ctx.fill()
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

function beatAtEvent(event: MouseEvent): number {
  const canvas = canvasEl.value
  if (!canvas) return 0
  const rect = canvas.getBoundingClientRect()
  return Math.max(0, (event.clientX - rect.left) / state.view.pxPerBeat)
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging = true
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  seek(beatAtEvent(event))
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return
  seek(beatAtEvent(event))
}

function onPointerUp(): void {
  dragging = false
}

function onWheel(event: WheelEvent): void {
  const wrap = wrapEl.value
  if (!wrap) return
  event.preventDefault()
  const max = Math.max(0, wrap.scrollWidth - wrap.clientWidth)
  const next = clamp(wrap.scrollLeft + event.deltaY + event.deltaX, 0, max)
  wrap.scrollLeft = next
  state.view.scrollLeft = next
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
  () => state.view.scrollLeft,
  (value) => {
    const wrap = wrapEl.value
    if (wrap && wrap.scrollLeft !== value) wrap.scrollLeft = value
    requestDraw()
  }
)

watch(
  () => [state.view.pxPerBeat, state.revision, state.playheadBeats, state.selectedTrackId, state.loopOn],
  () => requestDraw()
)
</script>

<template>
  <div class="ruler" :style="{ height: height + 'px' }">
    <!-- 左上角固定标签（不随横向滚动移动） -->
    <div class="corner" :style="{ width: KEY_WIDTH + 'px', height: RULER_HEIGHT + 'px' }">小节</div>
    <div ref="wrapEl" class="ruler-scroll" :style="{ paddingRight: SCROLLBAR_SIZE + 'px' }">
      <div :style="{ paddingLeft: KEY_WIDTH + 'px' }">
        <canvas
          ref="canvasEl"
          :style="{ width: totalWidth + 'px', height: height + 'px' }"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @wheel="onWheel"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ruler {
  position: relative;
  flex: 0 0 auto;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
}

.corner {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #22242b;
  border-right: 1px solid var(--line);
  color: var(--text-dim);
  font-size: 10px;
  pointer-events: none;
}

.ruler-scroll {
  height: 100%;
  overflow: hidden;
}

canvas {
  display: block;
  cursor: pointer;
}
</style>
