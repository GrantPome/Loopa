<script setup lang="ts">
/**
 * 历史工程弹窗：加载 / 删除 localStorage 中保存的工程
 */
import { deleteSavedProject, loadProjectById, state } from '@/core/store'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function onLoad(id: string): void {
  loadProjectById(id)
  emit('close')
}

function onDelete(id: string): void {
  deleteSavedProject(id)
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="dialog">
      <header class="head">
        <strong>历史工程</strong>
        <span class="dim">共 {{ state.savedProjects.length }} 个（最多保留 12 个）</span>
        <span class="gap" />
        <button @click="emit('close')">关闭</button>
      </header>

      <div class="list">
        <div v-for="item in state.savedProjects" :key="item.id" class="item" :class="{ current: item.id === state.project.id }">
          <div class="info">
            <div class="name">{{ item.name }}</div>
            <div class="meta">
              {{ item.bpm }} BPM · {{ item.timeSignature }} · {{ item.trackCount }} 轨 · {{ item.noteCount }} 音符
            </div>
            <div class="meta">{{ formatTime(item.updatedAt) }}</div>
          </div>
          <button class="primary" @click="onLoad(item.id)">加载</button>
          <button class="danger" title="删除该工程" @click="onDelete(item.id)">删除</button>
        </div>

        <p v-if="!state.savedProjects.length" class="empty">还没有保存过的工程</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.dialog {
  width: 460px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
}

.gap {
  flex: 1;
}

.dim {
  color: var(--text-dim);
  font-size: 12px;
}

.list {
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
}

.item.current {
  border-color: var(--accent);
}

.info {
  flex: 1;
  min-width: 0;
}

.name {
  font-weight: 600;
  margin-bottom: 2px;
}

.meta {
  color: var(--text-dim);
  font-size: 11px;
}

.primary {
  border-color: var(--accent);
  color: var(--accent);
}

.danger:hover {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.empty {
  color: var(--text-dim);
  text-align: center;
  padding: 20px;
}
</style>
