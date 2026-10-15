<script setup lang="ts">
/**
 * 应用主页（启动欢迎页）
 * Premiere Pro 风格欢迎页布局：
 * - 左侧菜单：主页 / 新建项目 / 打开项目，下方列表为团队项目入口（占位，即将推出）
 * - 右侧主内容区：
 *   - 主页：顶部大标题「欢迎使用 TonePome」，中间为音乐制作相关的简约线稿图标
 *     （钢琴键 / 音符 / 波形），下方是「编辑、效果和导出」标语
 *   - 打开项目：右侧直接展示最近保存的工程列表，可加载 / 删除，不再使用弹窗
 * - 仅负责入口跳转：新建 → 新建工程并进入编辑器；加载工程 → 载入后进入编辑器
 * 复用项目现有主题令牌（--bg / --panel / --accent），深色暗色 UI，PC / 移动端自适应。
 */
import { ref } from 'vue'
import { deleteSavedProject, loadProjectById, state } from '@/core/store'

const emit = defineEmits<{ (e: 'enter'): void; (e: 'new'): void; (e: 'history'): void }>()

/** 右侧主内容区视图：主页插画 / 最近项目列表 */
type HomeView = 'home' | 'projects'
const view = ref<HomeView>('home')

/** 左侧列表项：团队项目暂未开放，仅作占位展示 */
const comingSoonItems = ['新建团队项目', '打开团队项目']

/** 占位项点击：仅提示，不触发任何跳转 */
function onComingSoon(): void {
  state.statusText = '团队项目即将推出'
}

/** 打开项目：右侧切换到最近项目列表 */
function onOpenProjects(): void {
  view.value = 'projects'
}

/** 加载最近项目并进入编辑器 */
function onLoadProject(id: string): void {
  loadProjectById(id)
  emit('enter')
}

function onDeleteProject(id: string): void {
  deleteSavedProject(id)
}

/** 工程时间格式：YYYY-MM-DD HH:mm */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
</script>

<template>
  <div class="home">
    <!-- 欢迎窗口：居中浮动，还原 PR 欢迎页的双栏结构 -->
    <div class="welcome">
      <!-- 左侧菜单区 -->
      <aside class="menu">
        <div class="app-name">TonePome</div>

        <!-- 主页选项：右侧显示欢迎插画（与新建/打开项目同为菜单按钮样式） -->
        <button
          class="menu-btn"
          :class="{ active: view === 'home' }"
          @click="view = 'home'"
        >
          主页
        </button>

        <button class="menu-btn" @click="emit('new')">新建项目</button>
        <button
          class="menu-btn"
          :class="{ active: view === 'projects' }"
          @click="onOpenProjects"
        >
          打开项目
        </button>

        <nav class="menu-list">
          <button
            v-for="item in comingSoonItems"
            :key="item"
            class="menu-item"
            :title="`${item}（即将推出）`"
            @click="onComingSoon"
          >
            {{ item }}
          </button>
        </nav>
      </aside>

      <!-- 右侧主内容区（打开项目视图时改为从顶部向下排布） -->
      <main class="main" :class="{ projects: view === 'projects' }">
        <!-- 主页：欢迎插画 -->
        <template v-if="view === 'home'">
          <h1 class="title">欢迎使用 TonePome</h1>

          <!-- 简约线稿图标：钢琴键 / 音符 / 波形 -->
          <div class="art">
            <!-- 钢琴键 -->
            <svg class="art-icon" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="14" y="32" width="92" height="58" rx="6" />
              <path d="M37 32v58M60 32v58M83 32v58" opacity="0.6" />
              <path d="M30 32v32M49 32v32M72 32v32M95 32v32" stroke-width="7" />
              <path d="M20 26c10-8 24-10 36-5" opacity="0.35" />
            </svg>
            <!-- 八分音符 -->
            <svg class="art-icon" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M46 30l42 8" />
              <path d="M46 40l42 8" opacity="0.6" />
              <path d="M46 30v42M88 38v42" />
              <ellipse cx="38" cy="76" rx="9" ry="6.5" transform="rotate(-16 38 76)" />
              <ellipse cx="80" cy="84" rx="9" ry="6.5" transform="rotate(-16 80 84)" />
              <path d="M96 22c4 2 7 5 8 9" opacity="0.35" />
            </svg>
            <!-- 音频波形 -->
            <svg class="art-icon" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 66V54M30 74V46M42 82V38M54 94V28M66 80V40M78 94V26M90 72V48M102 62V58" stroke-width="4" />
              <path d="M14 34c8-6 18-8 26-5" opacity="0.35" />
            </svg>
          </div>

          <p class="slogan">编曲、混音和导出</p>
        </template>

        <!-- 打开项目：最近项目列表 -->
        <template v-else>
          <h1 class="title">打开项目</h1>

          <div class="project-list">
            <div
              v-for="item in state.savedProjects"
              :key="item.id"
              class="project-item"
              :class="{ current: item.id === state.project.id }"
            >
              <div class="project-info">
                <div class="project-name">{{ item.name }}</div>
                <div class="project-meta">
                  {{ item.bpm }} BPM · {{ item.timeSignature }} · {{ item.trackCount }} 轨 · {{ item.noteCount }} 音符
                </div>
                <div class="project-meta">{{ formatTime(item.updatedAt) }}</div>
              </div>
              <button class="load-btn" @click="onLoadProject(item.id)">打开</button>
              <button class="delete-btn" title="删除该工程" @click="onDeleteProject(item.id)">删除</button>
            </div>

            <p v-if="!state.savedProjects.length" class="empty">还没有保存过的工程</p>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* 主页外层：深色背景上居中放置欢迎窗口 */
.home {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
}

/* 欢迎窗口：PR 欢迎页式双栏卡片 */
.welcome {
  width: min(960px, 100%);
  height: min(600px, 100%);
  display: flex;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md), 0 24px 70px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  /* 入场淡入上浮，与全局弹窗保持同一手感 */
  animation: home-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes home-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ---------------------------------------------------------------- 左侧菜单区 */

.menu {
  flex: 0 0 240px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 28px 20px;
  background: var(--panel-2);
  border-right: 1px solid var(--line);
}

.app-name {
  margin-bottom: 18px;
  font-size: 12px;
  letter-spacing: 2px;
  color: var(--text-dim);
  text-transform: uppercase;
}

/* 菜单主按钮：深灰底白字，整宽，PR 菜单观感 */
.menu-btn {
  width: 100%;
  padding: 12px 14px;
  font-size: 13px;
  text-align: left;
  color: var(--text);
  background: var(--panel-3);
  border: 1px solid var(--line);
  border-radius: 4px;
}

.menu-btn:hover:not(:disabled) {
  background: var(--panel-hover);
  border-color: var(--line-strong);
}

/* 当前视图对应的菜单按钮高亮 */
.menu-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}

.menu-list {
  display: flex;
  flex-direction: column;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}

/* 列表项：纯文字菜单，悬停高亮 */
.menu-item {
  padding: 9px 10px;
  font-size: 12.5px;
  text-align: left;
  color: var(--text-dim);
  background: transparent;
  border: none;
  border-radius: 4px;
}

.menu-item:hover:not(:disabled) {
  color: var(--text);
  background: var(--panel-3);
}

/* ---------------------------------------------------------------- 右侧主内容区 */

.main {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 34px;
  padding: 36px 44px;
  overflow-y: auto;
}

/* 打开项目视图：列表从标题下方开始，自上而下排布，不垂直居中 */
.main.projects {
  justify-content: flex-start;
}

.title {
  position: absolute;
  top: 30px;
  left: 44px;
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--text);
}

/* 线稿图标组：白色描边、无填充，手绘简笔画观感 */
.art {
  display: flex;
  align-items: center;
  gap: 42px;
  color: var(--text);
}

.art-icon {
  width: 84px;
  height: 84px;
  opacity: 0.92;
}

.slogan {
  margin: 0;
  font-size: 15px;
  letter-spacing: 4px;
  color: var(--text-dim);
}

/* ---------------------------------------------------------------- 最近项目列表 */

.project-list {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 56px;
}

.project-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
}

.project-item.current {
  border-color: var(--accent);
}

.project-info {
  flex: 1;
  min-width: 0;
}

.project-name {
  font-weight: 600;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-meta {
  color: var(--text-dim);
  font-size: 11px;
}

.load-btn {
  border-color: var(--accent);
  color: var(--accent);
}

.delete-btn:hover:not(:disabled) {
  color: var(--accent-2);
  border-color: var(--accent-2);
}

.empty {
  color: var(--text-dim);
  text-align: center;
  padding: 40px 20px;
}

/* ---------------------------------------------------------------- 移动端适配 */

@media (max-width: 720px) {
  .home {
    padding: 12px;
  }

  .welcome {
    flex-direction: column;
    height: auto;
    max-height: 100%;
    overflow-y: auto;
  }

  .menu {
    flex: 0 0 auto;
    padding: 18px 16px;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }

  .app-name {
    margin-bottom: 10px;
  }

  .menu-list {
    margin-top: 10px;
    padding-top: 10px;
  }

  .main {
    gap: 24px;
    padding: 64px 20px 28px;
    overflow: visible;
  }

  .title {
    top: 18px;
    left: 20px;
    font-size: 18px;
  }

  .art {
    gap: 20px;
  }

  .art-icon {
    width: 56px;
    height: 56px;
  }

  .slogan {
    font-size: 13px;
    letter-spacing: 2px;
  }

  .project-list {
    margin-top: 24px;
  }
}

/* 尊重系统「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .welcome {
    animation: none;
  }
}
</style>
