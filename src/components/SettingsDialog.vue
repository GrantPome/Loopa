<script setup lang="ts">
/**
 * 设置对话框
 * - 设备模式：PC / Pad 手动切换
 * - Pad 专属设置：长按时长、虚拟键盘常驻
 * - 界面偏好：音量读数单位、力度条默认展开等
 * 打开方式：顶部工具栏「设置」按钮
 */
import { computed } from 'vue'
import type { DeviceMode } from '@/types'
import {
  closeSettings,
  setDeviceMode,
  setLongPressDuration,
  state,
  toggleNoteColor,
  toggleTouchKeyboardAlwaysOn,
  toggleVelocityLane,
  toggleVolumeDisplay
} from '@/core/store'
import { resetLayout, setEditMode } from '@/core/layout'

const emit = defineEmits<{ (e: 'close'): void }>()

const deviceOptions: { value: DeviceMode; label: string; desc: string }[] = [
  { value: 'pc', label: 'PC 桌面端', desc: '鼠标 + 键盘，信息密度高，右键菜单' },
  { value: 'pad', label: 'Pad 平板端', desc: '触控优先，控件放大，长按替代右键' }
]

const isPad = computed(() => state.deviceMode === 'pad')

/** 当前选中设备模式的说明文字 */
const deviceDesc = computed(() => deviceOptions.find((o) => o.value === state.deviceMode)?.desc ?? '')

function onDeviceChange(event: Event): void {
  const mode = (event.target as HTMLSelectElement).value as DeviceMode
  setDeviceMode(mode)
}

function onLongPressInput(event: Event): void {
  setLongPressDuration(Number((event.target as HTMLInputElement).value))
}

function onClose(): void {
  closeSettings()
  emit('close')
}

/** 进入布局编辑模式：关闭设置对话框，回到主界面拖拽板块 */
function onEnterEditMode(): void {
  closeSettings()
  setEditMode(true)
  emit('close')
}

/** 恢复默认布局（可重复使用，不会自动进入编辑模式） */
function onResetLayout(): void {
  resetLayout()
  state.statusText = '已恢复默认布局'
}
</script>

<template>
  <div class="overlay" @click.self="onClose">
    <div class="dialog">
      <header class="head">
        <span class="title">设置</span>
        <button class="close" title="关闭" @click="onClose">✕</button>
      </header>

      <div class="body">
        <section class="group">
          <h3>设备模式</h3>
          <p class="desc">选择当前设备的 UI 适配方案，可手动切换。</p>
          <select class="device-select" :value="state.deviceMode" @change="onDeviceChange">
            <option v-for="opt in deviceOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <p class="hint">
            {{ deviceDesc }}
          </p>
        </section>

        <section class="group">
          <h3>Pad 触控设置</h3>
          <p class="desc">仅在 Pad 模式下生效，用于调整触控交互手感。</p>

          <label class="row">
            <span class="label">长按时长</span>
            <input
              type="range"
              min="200"
              max="1000"
              step="50"
              :value="state.longPressDuration"
              :disabled="!isPad"
              @input="onLongPressInput"
            />
            <span class="value">{{ state.longPressDuration }} ms</span>
          </label>

          <label class="row switch-row">
            <span class="label">虚拟键盘常驻</span>
            <button
              class="toggle"
              :class="{ on: state.touchKeyboardAlwaysOn }"
              :disabled="!isPad"
              @click="toggleTouchKeyboardAlwaysOn"
            >
              {{ state.touchKeyboardAlwaysOn ? '开' : '关' }}
            </button>
          </label>
        </section>

        <section class="group">
          <h3>界面偏好</h3>

          <label class="row switch-row">
            <span class="label">音量读数单位</span>
            <button class="toggle" @click="toggleVolumeDisplay">
              {{ state.volumeDisplay === 'db' ? 'dB' : '线性 %' }}
            </button>
          </label>

          <label class="row switch-row">
            <span class="label">底部力度条</span>
            <button
              class="toggle"
              :class="{ on: state.velocityLaneOn }"
              @click="toggleVelocityLane"
            >
              {{ state.velocityLaneOn ? '展开' : '收起' }}
            </button>
          </label>

          <label class="row switch-row">
            <span class="label">按力度着色</span>
            <button
              class="toggle"
              :class="{ on: state.noteColorByVelocity }"
              @click="toggleNoteColor"
            >
              {{ state.noteColorByVelocity ? '开' : '关' }}
            </button>
          </label>
        </section>

        <section class="group">
          <h3>界面布局</h3>
          <p class="desc">
            进入编辑模式后，拖动板块顶部的标题栏即可调整顺序；把板块拖到其他区域，可与该区域的板块互换位置；拖动板块之间的分隔条，可调整相邻板块的宽高。
          </p>
          <div class="row layout-row">
            <button class="primary" @click="onEnterEditMode">进入编辑模式</button>
            <button @click="onResetLayout">恢复默认布局</button>
          </div>
          <p class="hint">
            左栏宽度与底部栏高度，可直接拖拽区域之间的分隔条调整；布局会自动保存。
          </p>
        </section>
      </div>

      <footer class="foot">
        <span class="tip">Muisc Editor · 网页版库乐队</span>
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
  width: 440px;
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
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}

.group:last-of-type {
  border-bottom: none;
  padding-bottom: 0;
}

.group h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.desc {
  margin: 0;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.6;
}

.hint {
  margin: 0;
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.6;
  font-style: italic;
}

.device-select {
  padding: 5px 8px;
}

/* 布局操作按钮行 */
.layout-row {
  gap: 8px;
}

.layout-row .primary {
  padding: 5px 14px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row .label {
  width: 96px;
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-dim);
}

.row input[type='range'] {
  flex: 1;
  min-width: 0;
}

.row .value {
  width: 56px;
  text-align: right;
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.switch-row .toggle {
  min-width: 56px;
  padding: 3px 10px;
  font-size: 12px;
}

.toggle.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #0d1117;
  font-weight: 600;
}

.toggle:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
}

.tip {
  font-size: 11px;
  color: var(--text-dim);
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
