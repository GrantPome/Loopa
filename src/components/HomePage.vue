<script setup lang="ts">
/**
 * 应用主页（启动欢迎页）
 * 还原 Premiere Pro 欢迎页布局：
 * - 左侧菜单：新建项目 / 打开项目，下方列表为团队项目与 Rush 项目入口（占位，即将推出）
 * - 右侧主内容区：顶部大标题「欢迎使用 Premiere Pro」，中间为剪辑相关的简约线稿图标，
 *   线稿下方是「编辑、效果和导出」标语，右下角为蓝色「新文件」按钮
 * - 仅负责入口跳转：新建 / 新文件 → 新建工程并进入编辑器；打开项目 → 打开本地工程弹窗
 * 复用项目现有主题令牌（--bg / --panel / --accent），深色暗色 UI，PC / 移动端自适应。
 */

import { state } from '@/core/store'

const emit = defineEmits<{ (e: 'enter'): void; (e: 'new'): void; (e: 'history'): void }>()

/** 左侧列表项：团队项目与 Rush 项目暂未开放，仅作占位展示 */
const comingSoonItems = ['新建团队项目', '打开团队项目', '打开 Premiere Rush 项目']

/** 占位项点击：仅提示，不触发任何跳转 */
function onComingSoon(): void {
  state.statusText = '团队项目与 Rush 项目即将推出'
}
</script>

<template>
  <div class="home">
    <!-- 欢迎窗口：居中浮动，还原 PR 欢迎页的双栏结构 -->
    <div class="welcome">
      <!-- 左侧菜单区 -->
      <aside class="menu">
        <div class="app-name">TonePome</div>

        <button class="menu-btn" @click="emit('new')">新建项目</button>
        <button class="menu-btn" @click="emit('history')">打开项目</button>

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

      <!-- 右侧主内容区 -->
      <main class="main">
        <h1 class="title">欢迎使用 TonePome</h1>

        <!-- 简约线稿图标：摄像机 / 素材 / 播放箭头 -->
        <div class="art">
          <!-- 摄像机 -->
          <svg class="art-icon" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="14" y="40" width="58" height="42" rx="6" />
            <path d="M72 52l30-12v44l-30-12" />
            <circle cx="30" cy="52" r="4" />
            <path d="M20 34c8-8 22-10 32-4" opacity="0.5" />
          </svg>
          <!-- 素材（胶片） -->
          <svg class="art-icon" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="20" y="30" width="80" height="60" rx="5" />
            <path d="M20 46h80M20 74h80" />
            <path d="M38 30v16M56 30v16M74 30v16M38 74v16M56 74v16M74 74v16" opacity="0.6" />
            <path d="M30 60h60" opacity="0.35" />
          </svg>
          <!-- 播放箭头 -->
          <svg class="art-icon" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M60 16c24 0 44 20 44 44s-20 44-44 44-44-20-44-44 20-44 44-44z" opacity="0.6" />
            <path d="M50 42l30 18-30 18z" />
            <path d="M30 26c6-4 12-6 18-7" opacity="0.35" />
          </svg>
        </div>

        <p class="slogan">编辑、效果和导出</p>

        <!-- 右下角：新文件 -->
        <button class="new-file" @click="emit('new')">新文件</button>
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

/* 右下角蓝色「新文件」按钮 */
.new-file {
  position: absolute;
  right: 28px;
  bottom: 24px;
  padding: 10px 26px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  border: none;
  border-radius: 4px;
  box-shadow: 0 2px 12px rgba(79, 157, 247, 0.35);
}

.new-file:hover:not(:disabled) {
  background: #6ab4ff;
  box-shadow: 0 4px 18px rgba(79, 157, 247, 0.45);
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
    padding: 64px 20px 84px;
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
}

/* 尊重系统「减少动态效果」偏好 */
@media (prefers-reduced-motion: reduce) {
  .welcome {
    animation: none;
  }
}
</style>
