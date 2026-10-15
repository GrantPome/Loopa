<script setup lang="ts">
/**
 * 布局节点（自递归渲染）
 * - 面板节点：渲染板块内容；编辑模式下额外渲染拖拽标题栏与拦截点击的遮罩
 * - 分割节点：按 dir 横向并排 / 纵向堆叠子节点，相邻子节点之间渲染尺寸分隔条
 * 子节点的主轴尺寸由父节点给出的占比（flex-grow）决定，窗口缩放时等比自适应。
 * 组件通过文件名自引用，因此可以渲染任意深度的嵌套布局。
 */
import type { Component } from 'vue'
import type { LayoutNode, PanelId } from '@/types'
import { PANEL_LABELS, layoutUi, startPanelDrag, startSplitResize } from '@/core/layout'
import TrackList from './TrackList.vue'
import FxPanel from './FxPanel.vue'
import EditorPanel from './EditorPanel.vue'
import NoteInspector from './NoteInspector.vue'
import VirtualKeyboard from './VirtualKeyboard.vue'
import MasterPanel from './MasterPanel.vue'

const props = defineProps<{ node: LayoutNode }>()

/** 板块 id → 组件 */
const COMPONENTS: Record<PanelId, Component> = {
  tracks: TrackList,
  fx: FxPanel,
  editor: EditorPanel,
  inspector: NoteInspector,
  keyboard: VirtualKeyboard,
  master: MasterPanel
}

/** 子节点在父容器主轴上的尺寸：占比直接作为 flex-grow，flex-basis 归零保证严格按占比分配 */
function childStyle(index: number) {
  const sizes = props.node.type === 'split' ? props.node.sizes : []
  return { flex: `${sizes[index] ?? 1} 1 0` }
}
</script>

<template>
  <!-- 面板叶子 -->
  <div
    v-if="node.type === 'panel'"
    class="dock-panel"
    :data-panel="node.id"
    :class="{ dragging: layoutUi.dragPanel === node.id }"
  >
    <!-- 编辑模式下的拖拽标题栏 -->
    <div
      v-if="layoutUi.editMode"
      class="dock-handle"
      :title="`拖动「${PANEL_LABELS[node.id]}」，拖到别的板块上/下/左/右边缘即可插入`"
      @pointerdown="startPanelDrag($event, node.id)"
    >
      <span class="grip" aria-hidden="true">⠿</span>
      <span class="name">{{ PANEL_LABELS[node.id] }}</span>
    </div>

    <div class="dock-body">
      <component :is="COMPONENTS[node.id]" />
      <!-- 编辑模式遮罩：拦截板块内的功能点击，整块面板都可拖拽 -->
      <div
        v-if="layoutUi.editMode"
        class="dock-mask"
        :title="`拖动「${PANEL_LABELS[node.id]}」，拖到别的板块上/下/左/右边缘即可插入`"
        @pointerdown="startPanelDrag($event, node.id)"
      />
    </div>
  </div>

  <!-- 分割容器：沿 dir 排列子节点 -->
  <div v-else class="dock-split-node" :class="node.dir === 'row' ? 'dir-row' : 'dir-column'">
    <template v-for="(child, i) in node.children" :key="child.type === 'panel' ? child.id : child.key">
      <DockNode :node="child" :style="childStyle(i)" />

      <!-- 编辑模式下相邻子节点之间的尺寸分隔条 -->
      <div
        v-if="layoutUi.editMode && i < node.children.length - 1"
        class="dock-split"
        :class="node.dir === 'row' ? 'split-v' : 'split-h'"
        title="拖动调整相邻两个板块的宽高"
        @pointerdown="startSplitResize($event, node, i)"
      />
    </template>
  </div>
</template>

<style scoped>
/*
 * 分割容器：row 横向并排、column 纵向堆叠。
 * min-width / min-height 必须显式归零，否则子级画布（钢琴卷帘 / 波形编辑器）会被固有尺寸撑大。
 */
.dock-split-node {
  display: flex;
  min-width: 0;
  min-height: 0;
}

.dir-row {
  flex-direction: row;
}

.dir-column {
  flex-direction: column;
}

/* 单个板块：主轴尺寸由父级传入的 flex 占比决定 */
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

/* 板块内容容器：建立独立层叠上下文，把遮罩的层级限制在本板块内 */
.dock-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 0;
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

/*
 * 覆盖在板块内容之上的遮罩：
 * 拦截所有点击 / 滚轮等交互，使编辑模式下只能用标题栏或整块面板拖拽。
 * z-index 高于板块内部浮层，但限制在 .dock-body 内，不会盖住插入预览。
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

/*
 * 相邻子节点之间的尺寸分隔条（仅编辑模式渲染）：
 * 横向容器里是竖向分隔条（调宽度），纵向容器里是横向分隔条（调高度）。
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
</style>
