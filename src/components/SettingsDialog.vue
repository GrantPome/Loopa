<script setup lang="ts">
/**
 * 设置对话框
 * - 设备模式：PC / Pad 手动切换
 * - Pad 专属设置：长按时长、虚拟键盘常驻
 * - MIDI 输入：启用 Web MIDI、选择输入设备
 * - 速度自动化：速度点列表管理
 * 打开方式：顶部工具栏「设置」按钮
 */
import { computed, ref } from 'vue'
import type { DeviceMode } from '@/types'
import {
  addTempoPoint,
  closeSettings,
  FEATURE_FLAGS,
  openInstrumentManager,
  removeTempoPoint,
  setDeviceMode,
  setLongPressDuration,
  state,
  toggleFeature,
  toggleLowNoteBoost,
  toggleNoteColor,
  toggleTouchKeyboardAlwaysOn,
  toggleVelocityLane,
  toggleVolumeDisplay
} from '@/core/store'
import { midiState, disableMidi, enableMidi, selectMidiDevice } from '@/core/midiInput'
import { resetLayout, setEditMode } from '@/core/layout'

const emit = defineEmits<{ (e: 'close'): void }>()

/** 左侧分类：通用 / 功能开关 / 音频与 MIDI / 界面 */
type SettingsTab = 'general' | 'features' | 'audio' | 'ui'
const tabs: { key: SettingsTab; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'features', label: '功能开关' },
  { key: 'audio', label: '音频与 MIDI' },
  { key: 'ui', label: '界面' }
]
const activeTab = ref<SettingsTab>('general')

/** 按分组整理功能开关，设置页按组分节展示 */
const featureGroups = computed(() => {
  const groups: { name: string; flags: typeof FEATURE_FLAGS }[] = []
  for (const flag of FEATURE_FLAGS) {
    let group = groups.find((g) => g.name === flag.group)
    if (!group) {
      group = { name: flag.group, flags: [] }
      groups.push(group)
    }
    group.flags.push(flag)
  }
  return groups
})

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

/** 打开「乐器与音源」管理器：先关闭设置，避免两个对话框叠加 */
function onOpenInstruments(): void {
  closeSettings()
  openInstrumentManager()
  emit('close')
}

// ------------------------------------------------------------ MIDI 输入

/** 启用 / 断开 Web MIDI */
async function onToggleMidi(): Promise<void> {
  if (midiState.enabled) disableMidi()
  else await enableMidi()
}

/** 切换监听的 MIDI 输入设备 */
function onMidiDeviceChange(event: Event): void {
  selectMidiDevice((event.target as HTMLSelectElement).value)
}

// ------------------------------------------------------------ 速度自动化

/** 新增速度点时使用的 BPM（默认与工程速度一致） */
const tempoBpmInput = ref(state.project.bpm)

/** 在当前播放头位置添加速度点 */
function onAddTempoPoint(): void {
  addTempoPoint(state.playheadBeats, tempoBpmInput.value)
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
        <!-- 左侧分类导航 -->
        <nav class="nav">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
          </button>
        </nav>

        <!-- 右侧内容区：只渲染当前分类 -->
        <div class="content">
          <template v-if="activeTab === 'general'">
            <section class="group">
              <h3>设备模式</h3>
              <p class="desc">选择当前设备的 UI 适配方案，可手动切换。</p>
              <select class="device-select" :value="state.deviceMode" @change="onDeviceChange">
                <option v-for="opt in deviceOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
              <p class="hint">{{ deviceDesc }}</p>
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
          </template>

          <template v-else-if="activeTab === 'features'">
            <section v-for="group in featureGroups" :key="group.name" class="group">
              <h3>{{ group.name }}</h3>
              <p v-if="group.name === featureGroups[0].name" class="desc">
                勾选启用 / 关闭某个功能；关闭只是从界面隐藏对应入口，不影响工程数据。
              </p>

              <label v-for="flag in group.flags" :key="flag.key" class="row switch-row">
                <span class="label">
                  {{ flag.label }}
                  <small class="flag-desc">{{ flag.desc }}</small>
                </span>
                <button
                  class="toggle"
                  :class="{ on: state.featureToggles[flag.key] }"
                  @click="toggleFeature(flag.key)"
                >
                  {{ state.featureToggles[flag.key] ? '开' : '关' }}
                </button>
              </label>
            </section>
          </template>

          <template v-else-if="activeTab === 'audio'">
            <section class="group">
              <h3>低频补偿</h3>
              <p class="desc">人耳和小型扬声器对低频敏感度低，C4 以下低音音符听不清。开启后自动提升低音区力度，不改动力度值本身。</p>
              <label class="row switch-row">
                <span class="label">低音区自动提音量</span>
                <button
                  class="toggle"
                  :class="{ on: state.lowNoteBoost }"
                  @click="toggleLowNoteBoost"
                >
                  {{ state.lowNoteBoost ? '开' : '关' }}
                </button>
              </label>
            </section>

            <section class="group">
              <h3>乐器与音源</h3>
              <p class="desc">
                在统一的管理器里浏览并试听全部内置音色，或导入自己的采样拼装成一套独立音源。内置音色的采样并不齐全（例如鼓组只有踩镲、缺少吊镲），可用自定义音源补齐。
              </p>
              <div class="row layout-row">
                <button class="primary" @click="onOpenInstruments">打开乐器与音源管理器</button>
              </div>
            </section>

            <section v-if="state.featureToggles.midi" class="group">
              <h3>MIDI 输入</h3>
              <p class="desc">
                连接硬件 MIDI 键盘：弹奏即可试听当前轨道音色；点顶栏「♪」进入录制待命后，弹奏的音符会写进当前轨道。
              </p>
              <div class="row layout-row">
                <button :class="{ primary: !midiState.enabled }" @click="onToggleMidi">
                  {{ midiState.enabled ? '断开 MIDI' : '启用 MIDI 输入' }}
                </button>
              </div>
              <p v-if="midiState.error" class="hint error">{{ midiState.error }}</p>
              <template v-if="midiState.enabled">
                <label class="row">
                  <span class="label">输入设备</span>
                  <select class="device-select" :value="midiState.selectedId" @change="onMidiDeviceChange">
                    <option value="">全部输入设备</option>
                    <option v-for="device in midiState.devices" :key="device.id" :value="device.id">
                      {{ device.name }}
                    </option>
                  </select>
                </label>
                <p class="hint">
                  {{ midiState.devices.length > 0 ? `检测到 ${midiState.devices.length} 个输入设备` : '未检测到输入设备，请连接后重试' }}
                </p>
              </template>
              <p v-else-if="!midiState.supported" class="hint error">当前浏览器不支持 Web MIDI，请使用 Chrome / Edge。</p>
            </section>

            <section v-if="state.featureToggles.tempoAutomation" class="group">
              <h3>速度自动化</h3>
              <p class="desc">
                在工程中途改变速度：第 0 拍的速度由顶部工具栏的 BPM 决定，之后可插入任意多个速度点，播放与导出都会按曲线平滑变速。
              </p>
              <div class="row layout-row">
                <input
                  class="tempo-bpm"
                  type="number"
                  min="40"
                  max="200"
                  v-model.number="tempoBpmInput"
                  title="新速度点的 BPM"
                />
                <button class="primary" @click="onAddTempoPoint">在播放头添加速度点</button>
              </div>
              <div v-if="state.project.tempoPoints.length" class="tempo-list">
                <div v-for="point in state.project.tempoPoints" :key="point.id" class="tempo-item">
                  <span>第 {{ Math.round(point.beat * 100) / 100 }} 拍</span>
                  <span class="dim">{{ point.bpm }} BPM</span>
                  <button class="danger" title="删除该速度点" @click="removeTempoPoint(point.id)">删除</button>
                </div>
              </div>
              <p v-else class="hint">还没有速度点，整首工程使用固定速度。</p>
            </section>
          </template>

          <template v-else>
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
                进入编辑模式后，拖动板块顶部的标题栏，放到目标板块的上 / 下 / 左 / 右边缘，即可把它插入到该位置（也可让板块并排或上下堆叠）；拖动板块之间的分隔条，可调整相邻板块的宽高。
              </p>
              <div class="row layout-row">
                <button class="primary" @click="onEnterEditMode">进入编辑模式</button>
                <button @click="onResetLayout">恢复默认布局</button>
              </div>
              <p class="hint">所有板块（含音符检查器）都能自由组合与嵌套，布局会自动保存。</p>
            </section>
          </template>
        </div>
      </div>

      <footer class="foot">
        <span class="tip">Loopa · 网页版库乐队</span>
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
  width: 620px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
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

/* 左右分栏 */
.body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: row;
}

/* 左侧导航 */
.nav {
  width: 128px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  border-right: 1px solid var(--line);
}

.nav button {
  text-align: left;
  padding: 6px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
}

.nav button.active {
  background: rgba(79, 157, 247, 0.15);
  color: var(--accent);
  font-weight: 600;
}

/* 右侧内容区 */
.content {
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

/* 速度点列表 */
.tempo-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}

.tempo-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
  font-size: 12px;
}

.tempo-item .dim {
  flex: 1;
  color: var(--text-dim);
}

.tempo-item .danger {
  padding: 2px 8px;
  font-size: 11px;
}

.tempo-bpm {
  width: 84px;
  padding: 5px 8px;
}

.hint.error {
  color: var(--accent-2);
  font-style: normal;
}

/* 功能开关的说明小字 */
.flag-desc {
  display: block;
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-dim);
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
