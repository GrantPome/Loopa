<script setup lang="ts">
/**
 * 顶部工具栏
 * 工程文件操作 / 播放控制 / BPM、拍号 / 节拍器 / 预备拍
 */
import { computed, ref } from 'vue'
import {
  state,
  newProject,
  saveProjectNow,
  exportProjectJson,
  importProjectJson,
  exportWav,
  renameProject,
  setBpm,
  setTimeSignature,
  setViewMode,
  toggleMetronome,
  toggleCountIn,
  toggleLoop,
  togglePlay,
  stop
} from '@/core/store'
import { beatsPerBarOf, formatPosition } from '@/utils/music'
import type { TimeSignature, ViewMode } from '@/types'

const emit = defineEmits<{ (e: 'open-history'): void }>()

const fileInput = ref<HTMLInputElement | null>(null)
const bpb = computed(() => beatsPerBarOf(state.project.timeSignature))
const position = computed(() => formatPosition(state.playheadBeats, bpb.value))

function onBpmChange(event: Event): void {
  setBpm(Number((event.target as HTMLInputElement).value))
}

function onTimeSignatureChange(event: Event): void {
  setTimeSignature((event.target as HTMLSelectElement).value as TimeSignature)
}

function onProjectNameChange(event: Event): void {
  renameProject((event.target as HTMLInputElement).value)
}

function onImportClick(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await importProjectJson(file)
  // 清空以便重复导入同一个文件
  input.value = ''
}
</script>

<template>
  <header class="toolbar">
    <!-- 工程 -->
    <div class="group">
      <span class="logo">Muisc</span>
      <input
        class="name-input"
        :value="state.project.name"
        title="工程名称"
        @change="onProjectNameChange"
      />
    </div>

    <div class="divider" />

    <div class="group">
      <button title="新建空白工程" @click="newProject">新建</button>
      <button title="保存到浏览器本地存储" @click="saveProjectNow">保存</button>
      <button title="查看历史工程" @click="emit('open-history')">历史</button>
      <button title="导入工程 JSON" @click="onImportClick">导入</button>
      <button title="导出工程 JSON" @click="exportProjectJson">导出 JSON</button>
      <button :disabled="state.busy" title="离线渲染并下载 WAV" @click="exportWav">
        {{ state.busy ? '渲染中…' : '导出 WAV' }}
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="application/json,.json"
        class="hidden-file"
        @change="onFileChange"
      />
    </div>

    <div class="divider" />

    <!-- 播放控制 -->
    <div class="group transport">
      <button class="icon" title="停止并回到起点" @click="stop">■</button>
      <button class="icon play" :class="{ active: state.isPlaying }" title="播放 / 暂停" @click="togglePlay">
        {{ state.isPlaying ? '❚❚' : '▶' }}
      </button>
      <button class="icon" :class="{ active: state.loopOn }" title="循环播放" @click="toggleLoop">↻</button>
      <span class="position" :class="{ counting: state.isCountingIn }">
        {{ state.isCountingIn ? '预备拍…' : position }}
      </span>
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
        <select :value="state.project.timeSignature" @change="onTimeSignatureChange">
          <option value="4/4">4/4</option>
          <option value="3/4">3/4</option>
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

    <!-- 中央编辑区视图切换 -->
    <div class="group views">
      <button
        :class="{ active: state.viewMode === 'piano' }"
        title="钢琴卷帘编辑器"
        @click="setViewMode('piano')"
      >
        钢琴卷帘
      </button>
      <button
        :class="{ active: state.viewMode === 'mixer' }"
        title="混音台：音量、声像、均衡、混响发送"
        @click="setViewMode('mixer')"
      >
        混音台
      </button>
    </div>

    <div class="divider" />

    <span v-if="!state.audioReady" class="hint">点击页面任意位置启用音频</span>
    <span v-else-if="state.statusText" class="status">{{ state.statusText }}</span>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
  row-gap: 6px;
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

.logo {
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--accent);
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

.transport .icon {
  min-width: 34px;
  text-align: center;
}

.transport .play {
  font-weight: 700;
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
