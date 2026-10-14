<script setup lang="ts">
/**
 * 布局区域容器
 * - 渲染区域内按顺序排列的功能板块，板块主轴尺寸由权重决定
 * - 编辑模式下为每个板块渲染可拖拽的标题栏，并在相邻板块之间渲染尺寸分隔条
 * - 拖拽时在落点位置绘制插入指示线，空区域显示放置提示
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import type { PanelId, RegionId } from '@/types'
import { PANEL_LABELS, dropLine, layout, layoutUi, startPanelDrag, startPanelResize } from '@/core/layout'
import TrackList from './TrackList.vue'
import FxPanel from './FxPanel.vue'
import EditorPanel from './EditorPanel.vue'
import VirtualKeyboard from './VirtualKeyboard.vue'
import MasterPanel from './MasterPanel.vue'

const props = defineProps<{ region: RegionId }>()

/** 板块 id → 组件 */
const COMPONENTS: Record<PanelId, Component> = {
  tracks: TrackList,
  fx: FxPanel,
  editor: EditorPanel,
  keyboard: VirtualKeyboard,
  master: MasterPanel
}

const panels = computed(() => layout[props.region])
const isEmpty = computed(() => panels.value.length === 0)

/** 区域尺寸：左栏控制宽度，底部栏控制高度，中央自适应 */
const regionStyle = computed(() => {
  if (props.region === 'left') return { width: `${layout.leftWidth}px` }
  if (props.region === 'bottom') return { height: `${layout.bottomHeight}px` }
  return undefined
})

/** 板块主轴尺寸：用权重做 flex-grow，同区域板块按比例分配主轴长度 */
function panelStyle(panel: PanelId) {
  return { flex: `${layout.panelWeight[panel]} 1 0` }
}

/** 插入指示线的绝对定位样式 */
const lineStyle = computed(() => {
  const line = dropLine.value
  if (!line || line.region !== props.region) return undefined
  return line.horizontal
    ? { left: `${line.offset}px`, top: '0', bottom: '0', width: '3px' }
    : { top: `${line.offset}px`, left: '0', right: '0', height: '3px' }
})
</script>

<template>
  <div
    class="dock-region"
    :data-region="region"
    :class="[
      `region-${region}`,
      { 'is-empty': isEmpty, editing: layoutUi.editMode, 'drop-active': layoutUi.dragPanel && layoutUi.dropRegion === region }
    ]"
    :style="regionStyle"
  >
    <template v-for="(panel, i) in panels" :key="panel">
      <div
        class="dock-panel"
        :data-panel="panel"
        :class="{ dragging: layoutUi.dragPanel === panel }"
        :style="panelStyle(panel)"
      >
        <!-- 编辑模式下的拖拽标题栏 -->
        <div
          v-if="layoutUi.editMode"
          class="dock-handle"
          :title="`拖动「${PANEL_LABELS[panel]}」调整位置`"
          @pointerdown="startPanelDrag($event, panel)"
        >
          <span class="grip" aria-hidden="true">⠿</span>
          <span class="name">{{ PANEL_LABELS[panel] }}</span>
        </div>

        <div class="dock-body">
          <component :is="COMPONENTS[panel]" />
          <!-- 编辑模式遮罩：拦截板块内的功能点击，整块面板都可拖拽排序 -->
          <div
            v-if="layoutUi.editMode"
            class="dock-mask"
            :title="`拖动「${PANEL_LABELS[panel]}」调整位置`"
            @pointerdown="startPanelDrag($event, panel)"
          />
        </div>
      </div>

      <!-- 编辑模式下相邻板块之间的尺寸分隔条：拖动调整宽高 -->
      <div
        v-if="layoutUi.editMode && i < panels.length - 1"
        class="dock-split"
        :class="region === 'bottom' ? 'split-v' : 'split-h'"
        :title="`拖动调整「${PANEL_LABELS[panel]}」与下一个板块的宽高`"
        @pointerdown="startPanelResize($event, region, i)"
      />
    </template>

    <!-- 空区域占位（编辑模式下显示，方便把板块拖回来） -->
    <div v-if="isEmpty" class="dock-empty">拖到此处</div>

    <!-- 插入位置指示线 -->
    <div
      v-if="layoutUi.dragPanel && dropLine && dropLine.region === region"
      class="drop-line"
      :style="lineStyle"
    />
  </div>
</template>

<style scoped>
.dock-region {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
}

/* 左栏：竖向排列，固定宽度（可拖拽调整） */
.region-left {
  flex: 0 0 auto;
  flex-direction: column;
  border-right: 1px solid var(--line);
}

/* 中央：竖向排列，占据剩余空间 */
.region-center {
  flex: 1 1 0;
  flex-direction: column;
}

/* 底部：横向排列，固定高度（可拖拽调整） */
.region-bottom {
  flex: 0 0 auto;
  flex-direction: row;
  border-top: 1px solid var(--line);
  background: var(--panel);
}

.dock-region.is-empty {
  display: none;
}

/* 编辑模式下即使为空也保留区域，作为可放置的目标 */
.dock-region.is-empty.editing {
  display: flex;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  margin: 4px;
}

.dock-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 12px;
  letter-spacing: 1px;
}

/* 单个板块：主轴尺寸由内联 flex 权重决定（编辑模式可拖拽调整） */
.dock-panel {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  transition: opacity 0.15s ease;
}

.dock-panel.dragging {
  opacity: 0.4;
}

/*
 * 板块之间的尺寸分隔条（仅编辑模式渲染）：
 * 纵向区域里是横向分隔条（调高度），横向区域里是纵向分隔条（调宽度）。
 * z-index 高于板块内遮罩（210），保证可点击。
 */
.dock-split {
  flex: 0 0 6px;
  position: relative;
  z-index: 300;
  touch-action: none;
}

.dock-split::after {
  content: '';
  position: absolute;
  background: rgba(79, 157, 247, 0.45);
  transition: background 0.15s ease;
}

.split-h {
  cursor: row-resize;
}

.split-h::after {
  left: 0;
  right: 0;
  top: 2px;
  height: 2px;
}

.split-v {
  cursor: col-resize;
}

.split-v::after {
  top: 0;
  bottom: 0;
  left: 2px;
  width: 2px;
}

.dock-split:hover::after,
.dock-split:active::after {
  background: var(--accent);
}

.dock-handle {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--panel-3);
  border-bottom: 1px solid var(--line);
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.dock-handle:active {
  cursor: grabbing;
}

.dock-handle .grip {
  font-size: 12px;
  opacity: 0.7;
}

.dock-handle .name {
  font-weight: 600;
  color: var(--text);
}

.dock-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 建立独立层叠上下文，把遮罩的层级限制在本板块内 */
  position: relative;
  z-index: 0;
}

/* 编辑模式：板块内容整体变暗，明确「不可操作」 */
.dock-region.editing .dock-body {
  opacity: 0.6;
}

/*
 * 覆盖在板块内容之上的遮罩：
 * 拦截所有点击 / 滚轮等交互，使编辑模式下只能用标题栏或整块面板拖拽排序。
 * z-index 高于板块内部的浮层（如波形编辑器、虚拟键盘的黑键），但被限制在 .dock-body 内，
 * 因此不会盖住区域级的插入指示线。
 */
.dock-mask {
  position: absolute;
  inset: 0;
  z-index: 210;
  background: rgba(19, 20, 24, 0.28);
  cursor: grab;
  touch-action: none;
}

.dock-mask:active {
  cursor: grabbing;
}

.dock-region.drop-active {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}

.drop-line {
  position: absolute;
  z-index: 5;
  background: var(--accent);
  border-radius: 2px;
  box-shadow: 0 0 8px var(--accent);
  pointer-events: none;
}
</style>
