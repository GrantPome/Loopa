<script setup lang="ts">
/**
 * 「乐器与音源」管理器
 *
 * 统一入口，替代此前分散的「自定义音源」对话框：
 * - 内置乐器：浏览全部内置音色、逐个试听、一键应用到当前 MIDI 轨道
 * - 自定义音源：导入自己的采样，拼装成一套独立音色
 *
 * 页签指示块复用 core/segThumb 的两段式滑动动画，与顶栏视图切换手感一致。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import type { InstrumentManagerTab } from '@/types'
import { closeInstrumentManager, setInstrumentTab, state } from '@/core/store'
import { useSegThumb } from '@/core/segThumb'
import BuiltinInstrumentsPanel from './BuiltinInstrumentsPanel.vue'
import CustomSoundsPanel from './CustomSoundsPanel.vue'

const TABS: { id: InstrumentManagerTab; label: string; title: string }[] = [
  { id: 'builtin', label: '内置乐器', title: '浏览全部内置音色，可逐个试听并应用到当前轨道' },
  { id: 'custom', label: '自定义音源', title: '导入自己的采样，拼装成一套独立音色' }
]

// 页签指示块：与顶栏共用同一套两段式滑动动画
const { thumbEl, setTabRef } = useSegThumb(() => state.instrumentTab)

function onClose(): void {
  // 关窗时 store 会顺带收掉正在播放的试听声音
  closeInstrumentManager()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') onClose()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="overlay" @click.self="onClose">
    <div class="dialog">
      <header class="head">
        <span class="title">乐器与音源</span>

        <!-- 页签：分段 Tab，指示块由 segThumb 驱动 -->
        <div class="seg-tabs">
          <span ref="thumbEl" class="seg-thumb" />
          <button
            v-for="tab in TABS"
            :key="tab.id"
            :ref="(el) => setTabRef(el, tab.id)"
            class="seg-tab"
            :class="{ active: state.instrumentTab === tab.id }"
            :title="tab.title"
            @click="setInstrumentTab(tab.id)"
          >
            {{ tab.label }}
          </button>
        </div>

        <span class="spacer" />
        <button class="close" title="关闭" @click="onClose">✕</button>
      </header>

      <!-- 两个页签的内容区：切换时做一次淡入滑动过渡 -->
      <div class="body">
        <Transition name="panel-swap" mode="out-in">
          <BuiltinInstrumentsPanel v-if="state.instrumentTab === 'builtin'" key="builtin" />
          <CustomSoundsPanel v-else key="custom" />
        </Transition>
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
  width: 760px;
  max-width: calc(100vw - 32px);
  /* 固定高度，保证左右两栏各自独立滚动，而不是整窗被内容撑高 */
  height: min(640px, calc(100vh - 48px));
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
  /* 挂载时上浮淡入 */
  animation: dialog-rise-in 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.title {
  font-weight: 600;
}

.spacer {
  flex: 1;
}

.close {
  padding: 2px 8px;
  font-size: 13px;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  /* 裁掉页签切换时内容横向滑动的溢出，避免盖到弹窗圆角边框 */
  overflow: hidden;
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

/* ---- 页签：分段 Tab（与顶栏视图切换同款） ---- */
.seg-tabs {
  position: relative;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
}

.seg-thumb {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 0;
  width: 0;
  border-radius: var(--radius);
  background: var(--accent);
  box-shadow: 0 1px 6px rgba(79, 157, 247, 0.35);
  pointer-events: none;
}

.seg-tab {
  position: relative;
  z-index: 1;
  min-height: 0;
  padding: 3px 14px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-dim);
  transition: color 0.2s ease;
}

.seg-tab:hover:not(.active) {
  background: transparent;
  border-color: transparent;
  color: var(--text);
}

.seg-tab.active {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  color: #0d1117;
  font-weight: 600;
}
</style>
