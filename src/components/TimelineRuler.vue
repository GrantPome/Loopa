<script setup lang="ts">
/**
 * 时间总轨：小节标尺 + 各轨道片段(Region)概览 + 播放头
 * 横向滚动与钢琴卷帘联动（共享 state.view）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  addMarker,
  duplicateClip,
  moveMarker,
  removeClip,
  removeMarker,
  renameMarker,
  resizeClip,
  seekMarker,
  selectAudioClip,
  splitClip,
  state,
  seek
} from '@/core/store'
import { beatsPerBarOf, clamp } from '@/utils/music'
import type { TimelineMarker } from '@/types'
import { hexToRgba } from '@/utils/color'
import { peakRange } from '@/utils/waveform'
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
  ctx.font = '10px "HarmonyOS Sans SC", system-ui, sans-serif'
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

    // 音频轨：绘制波形片段（用峰值缩略图），选中片段高亮
    if (track.kind === 'audio') {
      const secondsPerBeat = 60 / state.project.bpm
      for (const clip of track.clips) {
        const x = clip.start * px
        const clipW = clip.duration * px
        if (x + clipW < viewL || x > viewR) continue
        const selected = isActive && clip.id === state.selectedClipId
        ctx.fillStyle = hexToRgba(track.color, selected ? 0.5 : 0.22)
        ctx.fillRect(x, y + 2, Math.max(2, clipW), LANE_HEIGHT - 4)

        const buckets = Math.floor(clip.peaks.length / 2)
        if (buckets > 0 && clip.sourceDuration > 0) {
          const midY = y + LANE_HEIGHT / 2
          const amp = (LANE_HEIGHT - 8) / 2
          const offsetRatio = clip.offset / clip.sourceDuration
          const usedRatio = (clip.duration * secondsPerBeat) / clip.sourceDuration
          ctx.fillStyle = hexToRgba(track.color, selected ? 1 : 0.72)
          const from = Math.max(x, viewL)
          const to = Math.min(x + clipW, viewR)
          for (let cx = Math.floor(from); cx < to; cx += 1) {
            const r0 = (cx - x) / Math.max(1, clipW)
            const r1 = (cx + 1 - x) / Math.max(1, clipW)
            const { min, max } = peakRange(
              clip.peaks,
              offsetRatio + r0 * usedRatio,
              offsetRatio + r1 * usedRatio,
              buckets
            )
            const top = midY - max * amp
            const bottom = midY - min * amp
            ctx.fillRect(cx, top, 1, Math.max(1, bottom - top))
          }
        }
      }
      return
    }

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

  // ---------- 标记点（标点 / 卡点） ----------
  // 竖线贯穿整个总轨方便对齐，旗标与标签画在标尺带上，先画再叠播放头
  let labelEndX = -Infinity
  for (const marker of state.project.markers) {
    const mx = marker.beat * px
    if (mx < viewL - 40 || mx > viewR + 40) continue
    const selected = marker.id === state.selectedMarkerId

    // 贯穿线（虚线感用短段落实现，避免依赖 setLineDash 的缩放差异）
    ctx.fillStyle = selected ? 'rgba(79, 157, 247, 0.85)' : 'rgba(79, 157, 247, 0.34)'
    for (let y = RULER_HEIGHT; y < cssHeight; y += 6) ctx.fillRect(mx, y, 1, 3)

    // 旗标：标尺带内的三角小旗
    ctx.fillStyle = selected ? '#7cb8ff' : '#4f9df7'
    ctx.beginPath()
    ctx.moveTo(mx - 4, 1)
    ctx.lineTo(mx + 4, 1)
    ctx.lineTo(mx, 9)
    ctx.closePath()
    ctx.fill()

    // 标签：与相邻标签不重叠时才绘制，避免卡点密集时糊成一片
    if (mx + 4 >= labelEndX + 4) {
      ctx.font = '10px "HarmonyOS Sans SC", system-ui, sans-serif'
      ctx.fillStyle = selected ? '#ffffff' : 'rgba(255, 255, 255, 0.62)'
      const text = marker.label
      ctx.fillText(text, mx + 6, 5)
      labelEndX = mx + 6 + ctx.measureText(text).width
    }
  }

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

/** 命中测试：判断点击落在哪条音频轨的哪个波形片段上，并区分边缘修剪区 */
function clipAt(event: PointerEvent | MouseEvent): { trackId: string; clipId: string; edge: 'left' | 'right' | 'body' } | null {
  const canvas = canvasEl.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  const laneIndex = Math.floor((event.clientY - rect.top - RULER_HEIGHT) / LANE_HEIGHT)
  if (laneIndex < 0) return null
  const track = state.project.tracks.slice(0, laneCount.value)[laneIndex]
  if (!track || track.kind !== 'audio') return null
  const beat = Math.max(0, (event.clientX - rect.left) / state.view.pxPerBeat)
  const clip = track.clips.find((c) => beat >= c.start && beat <= c.start + c.duration)
  if (!clip) return null
  // 左右各 6px 为修剪手柄热区
  const edgeBeats = 6 / state.view.pxPerBeat
  const edge =
    beat - clip.start <= edgeBeats ? 'left' : clip.start + clip.duration - beat <= edgeBeats ? 'right' : 'body'
  return { trackId: track.id, clipId: clip.id, edge }
}

/** 当前正在修剪的片段与手柄 */
let trimming: { trackId: string; clipId: string; edge: 'left' | 'right' } | null = null
/** 右键菜单项：style 为 separator 时渲染成分隔线 */
interface ContextMenuItem {
  label: string
  style?: 'separator'
  danger?: boolean
  disabled?: boolean
  run?: () => void
}

/** 右键菜单状态：标点与片段共用同一个菜单，天然不会重叠 */
const contextMenu = ref<{ x: number; y: number; items: ContextMenuItem[] } | null>(null)
/** 当前正在拖拽的标记点 id（'' 表示未拖拽） */
let draggingMarkerId = ''

/** 命中测试：标尺带上的标记点旗标（±6px 判定） */
function markerAt(event: PointerEvent | MouseEvent): TimelineMarker | null {
  const canvas = canvasEl.value
  if (!canvas) return null
  const rect = canvas.getBoundingClientRect()
  // 只能在标尺带上抓旗标，避免误抢轨道区域的点击
  if (event.clientY - rect.top > RULER_HEIGHT + 2) return null
  const beat = Math.max(0, (event.clientX - rect.left) / state.view.pxPerBeat)
  let best: TimelineMarker | null = null
  let bestDistance = 6 / state.view.pxPerBeat
  for (const marker of state.project.markers) {
    const distance = Math.abs(marker.beat - beat)
    if (distance < bestDistance) {
      best = marker
      bestDistance = distance
    }
  }
  return best
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  contextMenu.value = null
  // 标尺上的标记点优先：抓旗标即选中并开始拖动，不移动播放头
  const marker = markerAt(event)
  if (marker) {
    seekMarker(marker.id)
    draggingMarkerId = marker.id
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    return
  }
  const hit = clipAt(event)
  if (hit) selectAudioClip(hit.trackId, hit.clipId)
  // 点到片段边缘：进入修剪模式，不移动播放头
  if (hit && hit.edge !== 'body') {
    trimming = { trackId: hit.trackId, clipId: hit.clipId, edge: hit.edge }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
    return
  }
  dragging = true
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  seek(beatAtEvent(event))
}

/** 双击标尺带：空白处打点，双击已有旗标则重命名 */
function onDoubleClick(event: MouseEvent): void {
  const canvas = canvasEl.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  if (event.clientY - rect.top > RULER_HEIGHT) return
  const marker = markerAt(event)
  if (marker) {
    promptRenameMarker(marker)
    return
  }
  addMarker(beatAtEvent(event))
}

function onPointerMove(event: PointerEvent): void {
  const canvas = canvasEl.value
  // 拖拽标记点：实时改位置（store 内部按 coalesceKey 合并成一步）
  if (draggingMarkerId) {
    moveMarker(draggingMarkerId, beatAtEvent(event))
    return
  }
  // 修剪中：根据手柄方向改写片段起止
  if (trimming) {
    const track = state.project.tracks.find((t) => t.id === trimming!.trackId)
    const clip = track?.clips.find((c) => c.id === trimming!.clipId)
    if (!track || !clip) return
    const spb = 60 / state.project.bpm
    const beat = beatAtEvent(event)
    if (trimming.edge === 'left') {
      // 从头部裁剪：右端不动，起点与源内偏移同步后移
      const nextStart = clamp(beat, 0, clip.start + clip.duration - 0.125)
      resizeClip(track.id, clip.id, {
        start: nextStart,
        offset: clip.offset + (nextStart - clip.start) * spb,
        duration: clip.duration - (nextStart - clip.start)
      })
    } else {
      // 从尾部裁剪：只改时长
      resizeClip(track.id, clip.id, { duration: Math.max(0.125, beat - clip.start) })
    }
    return
  }
  // 悬停反馈：标记点用抓取光标，片段边缘用左右箭头
  if (!dragging && canvas) {
    if (markerAt(event)) {
      canvas.style.cursor = 'grab'
    } else {
      const hit = clipAt(event)
      canvas.style.cursor = hit && hit.edge !== 'body' ? 'ew-resize' : ''
    }
  }
  if (!dragging) return
  seek(beatAtEvent(event))
}

function onPointerUp(): void {
  dragging = false
  trimming = null
  draggingMarkerId = ''
}

/**
 * 右键菜单：按命中目标给出不同操作
 * - 点到标点旗标：重命名 / 删除标点（不会被立即删除，需在菜单里确认点击）
 * - 点到波形片段：片段操作 + 就地打标点
 * - 点到标尺空白：就地打标点
 */
function onContextMenu(event: MouseEvent): void {
  const canvas = canvasEl.value
  if (!canvas) return
  const inRuler = event.clientY - canvas.getBoundingClientRect().top <= RULER_HEIGHT
  const beat = beatAtEvent(event)

  const marker = markerAt(event)
  if (marker) {
    event.preventDefault()
    contextMenu.value = {
      x: event.clientX,
      y: event.clientY,
      items: [
        { label: '重命名标点…', run: () => promptRenameMarker(marker) },
        { label: '', style: 'separator' },
        // 删除需要用户显式点击，避免右键误删
        { label: '删除标点', danger: true, run: () => removeMarker(marker.id) }
      ]
    }
    return
  }

  const hit = clipAt(event)
  if (!hit) {
    // 只处理标尺带上的空白右键，轨道区域的空白保留浏览器默认菜单
    if (!inRuler) return
    event.preventDefault()
    contextMenu.value = {
      x: event.clientX,
      y: event.clientY,
      items: [{ label: '在此处打标点', run: () => addMarker(beat) }]
    }
    return
  }

  event.preventDefault()
  selectAudioClip(hit.trackId, hit.clipId)
  const clip = state.project.tracks.find((t) => t.id === hit.trackId)?.clips.find((c) => c.id === hit.clipId)
  // 仅当播放头落在片段内部时允许「在播放头处分割」
  const canSplit = !!clip && state.playheadBeats > clip.start && state.playheadBeats < clip.start + clip.duration
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    items: [
      {
        label: '在播放头处分割',
        disabled: !canSplit,
        run: () => splitClip(hit.trackId, hit.clipId, state.playheadBeats)
      },
      { label: '再制', run: () => duplicateClip(hit.trackId, hit.clipId) },
      { label: '', style: 'separator' },
      { label: '在此处打标点', run: () => addMarker(beat) },
      { label: '', style: 'separator' },
      { label: '删除片段', danger: true, run: () => removeClip(hit.trackId, hit.clipId) }
    ]
  }
}

/** 点击菜单项：先关闭菜单再执行，避免操作后菜单残留 */
function runContextItem(item: ContextMenuItem): void {
  contextMenu.value = null
  item.run?.()
}

/** 弹出重命名输入框并写入 */
function promptRenameMarker(marker: TimelineMarker): void {
  const next = window.prompt('标点名称', marker.label)
  if (next === null) return
  renameMarker(marker.id, next)
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
  () => [
    state.view.pxPerBeat,
    state.revision,
    state.playheadBeats,
    state.selectedTrackId,
    state.selectedClipId,
    state.selectedMarkerId,
    state.loopOn,
    // 标记点的位置与名称会被就地改写，这里用指纹字符串触发重绘
    () => state.project.markers.map((m) => `${m.beat}:${m.label}`).join('|')
  ],
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
          @pointercancel="onPointerUp"
          @dblclick="onDoubleClick"
          @contextmenu="onContextMenu"
          @wheel="onWheel"
        />
      </div>
    </div>

    <!-- 右键菜单（标点与波形片段共用，fixed 定位，坐标即指针位置） -->
    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="clip-menu-mask"
        @pointerdown="contextMenu = null"
        @contextmenu.prevent="contextMenu = null"
      >
        <div class="clip-menu" :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }" @pointerdown.stop>
          <template v-for="(item, index) in contextMenu.items" :key="index">
            <span v-if="item.style === 'separator'" class="clip-menu-sep" />
            <button
              v-else
              :disabled="item.disabled"
              :class="{ danger: item.danger }"
              @click="runContextItem(item)"
            >
              {{ item.label }}
            </button>
          </template>
        </div>
      </div>
    </Teleport>
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

/* 右键菜单遮罩：点击任意处关闭 */
.clip-menu-mask {
  position: fixed;
  inset: 0;
  z-index: 600;
}

.clip-menu {
  position: fixed;
  min-width: 140px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

/* 菜单分组分隔线 */
.clip-menu-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--line);
}

.clip-menu button {
  padding: 6px 10px;
  font-size: 12px;
  text-align: left;
  color: var(--text);
  background: transparent;
  border: none;
  border-radius: 4px;
}

.clip-menu button:hover:not(:disabled) {
  background: var(--panel-3);
}

.clip-menu button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.clip-menu .danger:hover {
  color: var(--accent-2);
}
</style>
