<script setup lang="ts">
/**
 * 顶部工具栏
 * 品牌与工程名 / 文件与导出下拉 / 播放与录音 / 撤销重做 / BPM 与拍号 /
 * 节拍器 / 视图切换（分段 Tab）
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  state,
  historyUi,
  newProject,
  saveProjectNow,
  exportProjectJson,
  importProjectJson,
  exportMidi,
  importMidiFile,
  exportWav,
  openSettings,
  renameProject,
  setBpm,
  setTimeSignature,
  setViewMode,
  toggleMetronome,
  toggleCountIn,
  toggleLoop,
  togglePlay,
  toggleRecording,
  redo,
  stop,
  undo
} from '@/core/store'
import { TIME_SIGNATURE_OPTIONS } from '@/types'
import type { TimeSignature, ViewMode } from '@/types'
import { layoutUi } from '@/core/layout'
import { useSegThumb } from '@/core/segThumb'
import { beatsPerBarOf, formatPosition } from '@/utils/music'

const emit = defineEmits<{ (e: 'open-history'): void }>()

const jsonInput = ref<HTMLInputElement | null>(null)
const midiInput = ref<HTMLInputElement | null>(null)
// ---------------------------------------------------------------- 文件 / 导出下拉菜单

type MenuKey = 'file' | 'export'

interface MenuItem {
  label: string
  desc: string
  action: () => void
  disabled?: boolean
}

interface MenuDef {
  key: MenuKey
  label: string
  title: string
  items: MenuItem[]
}

/** 当前展开的菜单（同一时间只允许一个） */
const openMenu = ref<MenuKey | null>(null)
/** 各菜单的定位容器，用于判断点击是否发生在菜单外部 */
const menuWraps = ref<Record<string, HTMLElement | null>>({})

function setMenuRef(el: unknown, key: MenuKey): void {
  menuWraps.value[key] = (el as HTMLElement | null) ?? null
}

function toggleMenu(key: MenuKey): void {
  openMenu.value = openMenu.value === key ? null : key
}

function closeMenus(): void {
  openMenu.value = null
}

/** 选中菜单项：先收起菜单再执行动作 */
function runMenuAction(action: () => void): void {
  closeMenus()
  action()
}

/** 菜单定义；用 computed 让「渲染中…」文案能随 state.busy 变化 */
const menus = computed<MenuDef[]>(() => [
  {
    key: 'file',
    label: '文件',
    title: '文件操作',
    items: [
      { label: '新建工程', desc: '清空并创建空白工程', action: newProject },
      { label: '保存', desc: '保存到浏览器本地存储', action: saveProjectNow },
      { label: '导入工程 JSON', desc: '从 .json 文件载入工程', action: () => jsonInput.value?.click() },
      { label: '导入 MIDI', desc: '把 .mid 文件追加为新轨道', action: () => midiInput.value?.click() },
      { label: '历史工程', desc: '查看并切换已保存的工程', action: () => emit('open-history') }
    ]
  },
  {
    key: 'export',
    label: '导出',
    title: '导出工程文件',
    items: [
      { label: '导出工程 JSON', desc: '完整工程数据，可再次导入', action: exportProjectJson },
      { label: '导出 MIDI', desc: '仅 MIDI 轨，导出 .mid 文件', action: exportMidi },
      {
        label: state.busy ? '渲染中…' : '导出 WAV',
        desc: '离线渲染完整混音为音频',
        action: () => void exportWav(),
        disabled: state.busy
      }
    ]
  }
])

// ---------------------------------------------------------------- 视图切换（分段 Tab）

const VIEW_TABS: { id: ViewMode; label: string; title: string }[] = [
  { id: 'piano', label: '钢琴卷帘', title: '钢琴卷帘编辑器（MIDI 轨）' },
  { id: 'audio', label: '波形', title: '波形编辑器（音频轨）' },
  { id: 'mixer', label: '混音台', title: '混音台：音量、声像、均衡、混响发送' }
]

/**
 * 分段 Tab 的滑动指示块：复用 core/segThumb 里的两段式动画，
 * 与「乐器与音源」管理器的页签保持一致的手感。
 */
const { thumbEl, setTabRef } = useSegThumb(() => state.viewMode)
// ---------------------------------------------------------------- 工程参数与显示

const bpb = computed(() => beatsPerBarOf(state.project.timeSignature))
const position = computed(() => formatPosition(state.playheadBeats, bpb.value))
/** 录音时长显示（分:秒） */
const recordTime = computed(() => {
  const total = Math.floor(state.recordingSeconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

function onBpmChange(event: Event): void {
  setBpm(Number((event.target as HTMLInputElement).value))
}

function onTimeSignatureChange(event: Event): void {
  setTimeSignature((event.target as HTMLSelectElement).value as TimeSignature)
}

function onProjectNameChange(event: Event): void {
  renameProject((event.target as HTMLInputElement).value)
}

async function onJsonChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await importProjectJson(file)
  // 清空以便重复导入同一个文件
  input.value = ''
}

async function onMidiChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await importMidiFile(file)
  input.value = ''
}

// ---------------------------------------------------------------- 文档级事件

/** 点击菜单以外的区域时收起（pointerdown 早于 click，避免误触其它按钮） */
function onDocPointerDown(event: PointerEvent): void {
  if (!openMenu.value) return
  const wrap = menuWraps.value[openMenu.value]
  if (wrap && !wrap.contains(event.target as Node)) closeMenus()
}

/** Esc 键收起菜单 */
function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenus()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onDocKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onDocKeydown)
})
</script>

<template>
  <header class="toolbar">
    <!-- 品牌与工程名 -->
    <div class="group brand">
      <span class="logo" role="img" aria-label="TonePome" />
      <input
        class="name-input"
        :value="state.project.name"
        title="工程名称"
        @change="onProjectNameChange"
      />
    </div>

    <div class="divider" />

    <!-- 文件 / 导出：下拉菜单 -->
    <div class="group">
      <div
        v-for="menu in menus"
        :key="menu.key"
        :ref="(el) => setMenuRef(el, menu.key)"
        class="menu-wrap"
      >
        <button
          class="menu-trigger"
          :class="{ active: openMenu === menu.key }"
          :title="menu.title"
          @click="toggleMenu(menu.key)"
        >
          {{ menu.label }}<span class="caret">▾</span>
        </button>
        <div v-if="openMenu === menu.key" class="menu-panel">
          <button
            v-for="item in menu.items"
            :key="item.label"
            class="menu-item"
            :disabled="item.disabled"
            @click="runMenuAction(item.action)"
          >
            <span class="menu-item-name">{{ item.label }}</span>
            <span class="menu-item-desc">{{ item.desc }}</span>
          </button>
        </div>
      </div>
      <button title="设置" @click="openSettings">⚙</button>
      <input ref="jsonInput" type="file" accept="application/json,.json" class="hidden-file" @change="onJsonChange" />
      <input ref="midiInput" type="file" accept="audio/midi,.mid,.midi" class="hidden-file" @change="onMidiChange" />
    </div>

    <div class="divider" />

    <!-- 播放与录音 -->
    <div class="group transport">
      <button class="icon" title="停止并回到起点" @click="stop">■</button>
      <button class="icon play" :class="{ active: state.isPlaying }" title="播放 / 暂停" @click="togglePlay">
        {{ state.isPlaying ? '❚❚' : '▶' }}
      </button>
      <button class="icon" :class="{ active: state.loopOn }" title="循环播放" @click="toggleLoop">↻</button>
      <button
        class="icon record"
        :class="{ active: state.recording }"
        :title="state.recording ? '停止录音' : '从播放头位置开始录音（麦克风）'"
        @click="toggleRecording()"
      >
        ●
      </button>
      <span v-if="state.recording" class="rec-time">{{ recordTime }}</span>
      <span v-else class="position" :class="{ counting: state.isCountingIn }">
        {{ state.isCountingIn ? '预备拍…' : position }}
      </span>
    </div>

    <div class="divider" />

    <!-- 撤销 / 重做 -->
    <div class="group">
      <button
        class="icon"
        :disabled="!historyUi.canUndo"
        :title="historyUi.canUndo ? `撤销：${historyUi.undoLabel}（Ctrl+Z）` : '没有可撤销的操作'"
        @click="undo"
      >
        ↶
      </button>
      <button
        class="icon"
        :disabled="!historyUi.canRedo"
        :title="historyUi.canRedo ? `重做：${historyUi.redoLabel}（Ctrl+Shift+Z）` : '没有可重做的操作'"
        @click="redo"
      >
        ↷
      </button>
    </div>

    <div class="divider" />

    <!-- 速度与拍号 -->
    <div class="group">
      <label class="field">
        BPM
        <input
          class="num"
          type="number"
          min="40"
          max="200"
          step="1"
          :value="state.project.bpm"
          @change="onBpmChange"
        />
      </label>
      <label class="field">
        拍号
        <select :value="state.project.timeSignature" title="拍号（含复合拍子）" @change="onTimeSignatureChange">
          <option v-for="option in TIME_SIGNATURE_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </label>
      <button :class="{ active: state.metronomeOn }" title="节拍器开关" @click="toggleMetronome">
        节拍器
      </button>
      <button :class="{ active: state.countInOn }" title="播放前一小节预备拍" @click="toggleCountIn">
        预备拍
      </button>
    </div>

    <div class="spacer" />

    <!-- 中央编辑区视图切换：分段 Tab -->
    <div class="seg-tabs">
      <span ref="thumbEl" class="seg-thumb" />
      <button
        v-for="tab in VIEW_TABS"
        :key="tab.id"
        :ref="(el) => setTabRef(el, tab.id)"
        class="seg-tab"
        :class="{ active: state.viewMode === tab.id }"
        :title="tab.title"
        @click="setViewMode(tab.id)"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="divider" />

    <span v-if="!state.audioReady" class="hint">点击页面任意位置启用音频</span>
    <span v-else-if="state.statusText" class="status">{{ state.statusText }}</span>

    <!-- 布局编辑模式下锁住工具栏全部功能，只允许在下方拖拽编排板块 -->
    <div v-if="layoutUi.editMode" class="toolbar-mask" title="布局编辑模式：功能已锁定，仅可拖拽编排板块位置" />
  </header>
</template>

<style scoped>
.toolbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  row-gap: 6px;
}

/* 编辑模式遮罩：盖住整条工具栏，屏蔽所有按钮点击 */
.toolbar-mask {
  position: absolute;
  inset: 0;
  z-index: 400;
  background: rgba(19, 20, 24, 0.4);
  cursor: not-allowed;
}

.group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.divider {
  width: 1px;
  height: 22px;
  background: var(--line);
}

.spacer {
  flex: 1;
}

/*
 * 品牌 LOGO：整条横图（728×128）用 CSS mask 着色，
 * 背景色取主题强调色，因此深浅色模式下都能正常显示
 * （源 SVG 是纯白 + 透明底，直接当图片贴在浅色背景上会看不见）。
 */
.logo {
  display: inline-block;
  width: 102px;
  height: 18px;
  background-color: var(--accent);
  -webkit-mask: url('../assets/tone-pome-logo.svg') no-repeat center / contain;
  mask: url('../assets/tone-pome-logo.svg') no-repeat center / contain;
}

.name-input {
  width: 130px;
}

.num {
  width: 58px;
}

.field {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-dim);
}

.hidden-file {
  display: none;
}

/* ---- 下拉菜单（文件 / 导出） ---- */
.menu-wrap {
  position: relative;
}

.menu-trigger {
  white-space: nowrap;
}

.menu-trigger .caret {
  margin-left: 3px;
  font-size: 10px;
  opacity: 0.85;
}

/* 菜单浮层：向下展开，左对齐触发器 */
.menu-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 300;
  min-width: 216px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--panel-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  animation: menu-pop 0.14s cubic-bezier(0.22, 1, 0.36, 1);
}

@keyframes menu-pop {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.menu-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  min-height: 0;
  padding: 6px 9px;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
}

.menu-item:hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: transparent;
}

.menu-item-name {
  font-weight: 600;
}

.menu-item-desc {
  color: var(--text-dim);
  font-size: 11px;
}

/* ---- 视图切换：分段 Tab ---- */
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

/* 选中指示块：位置与宽度由脚本按两段式动画驱动 */
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
  padding: 3px 12px;
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

/* 覆盖全局 button.active 的高亮底色，改由指示块承担 */
.seg-tab.active {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  color: #0d1117;
  font-weight: 600;
}

.transport .icon {
  min-width: 34px;
  text-align: center;
}

.transport .play {
  font-weight: 700;
}

/* 录音键：红色常亮表示进行中，并做呼吸提示 */
.record {
  color: #ff6b85;
}

.record.active {
  background: var(--accent-2);
  border-color: var(--accent-2);
  color: #fff;
  animation: rec-pulse 1.2s ease-in-out infinite;
}

@keyframes rec-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(255, 77, 109, 0.55);
  }
  50% {
    box-shadow: 0 0 0 5px rgba(255, 77, 109, 0);
  }
}

.rec-time {
  min-width: 78px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: #ff6b85;
  background: var(--panel-2);
  border: 1px solid var(--accent-2);
  border-radius: var(--radius);
  padding: 3px 6px;
}

.position {
  min-width: 78px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 3px 6px;
}

.position.counting {
  color: var(--accent-2);
}

.hint {
  color: var(--accent-2);
}

.status {
  color: var(--text-dim);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
