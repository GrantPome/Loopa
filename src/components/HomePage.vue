<script setup lang="ts">
/**
 * 应用主页（欢迎页）
 * 打开站点时先展示，提供「进入编辑器 / 新建工程 / 历史工程」入口与功能简介。
 * 视觉沿用编辑器主题令牌（--bg / --panel / --accent），LOGO 用 CSS mask 着色适配深浅模式。
 */
import { state } from '@/core/store'

const emit = defineEmits<{ (e: 'enter'): void; (e: 'new'): void; (e: 'history'): void }>()

/** 功能简介卡片 */
const features = [
  {
    title: '钢琴卷帘编曲',
    desc: '绘制与框选音符、力度条、音阶锁定，长按快捷操作，触屏也顺手。'
  },
  {
    title: '音频轨与效果器',
    desc: '录音与波形裁剪，压缩 / 混响 / 均衡等效果器实时可调。'
  },
  {
    title: '编组与导出',
    desc: '轨道编组、侧链压缩、自动化包络，离线渲染导出 WAV 与 MIDI。'
  }
]
</script>

<template>
  <div class="home">
    <!-- 品牌与主操作 -->
    <section class="hero">
      <span class="logo" role="img" aria-label="TonePome" />
      <h1>网页版库乐队</h1>
      <p class="tagline">在浏览器里写谱、编曲、混音与导出；工程数据保存在本地，打开即用。</p>

      <div class="actions">
        <button class="primary" @click="emit('enter')">进入编辑器</button>
        <button @click="emit('new')">新建工程</button>
        <button class="ghost" @click="emit('history')">历史工程</button>
      </div>

      <p class="meta">
        当前工程：{{ state.project.name }} · {{ state.project.tracks.length }} 条轨道
      </p>
    </section>

    <!-- 功能简介 -->
    <section class="cards">
      <article v-for="item in features" :key="item.title" class="card">
        <h3>{{ item.title }}</h3>
        <p>{{ item.desc }}</p>
      </article>
    </section>

    <a class="repo" href="https://github.com/GrantPome/TonePome" target="_blank" rel="noreferrer">
      GitHub 源码与更新
    </a>
  </div>
</template>

<style scoped>
.home {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 40px 24px;
  background: var(--bg);
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  max-width: 620px;
  text-align: center;
  /* 入场淡入上浮，与其它弹窗保持同一手感 */
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

/* LOGO：整条横图用 mask 着色，取主题强调色 */
.logo {
  width: min(320px, 70vw);
  height: 52px;
  background-color: var(--accent);
  -webkit-mask: url('../assets/tone-pome-logo.svg') no-repeat center / contain;
  mask: url('../assets/tone-pome-logo.svg') no-repeat center / contain;
}

h1 {
  margin: 0;
  font-size: 26px;
  letter-spacing: 1px;
}

.tagline {
  margin: 0;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.8;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.actions button {
  padding: 8px 18px;
  font-size: 13px;
}

.ghost {
  background: transparent;
  color: var(--text-dim);
}

.ghost:hover {
  color: var(--text);
}

.meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
}

/* 功能卡片 */
.cards {
  display: flex;
  gap: 14px;
  width: 100%;
  max-width: 720px;
}

.card {
  flex: 1 1 0;
  min-width: 0;
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  animation: home-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}

.card:nth-child(2) {
  animation-delay: 0.06s;
}

.card:nth-child(3) {
  animation-delay: 0.12s;
}

.card h3 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--accent);
}

.card p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

.repo {
  font-size: 12px;
  color: var(--text-dim);
}

.repo:hover {
  color: var(--accent);
}

/* 窄屏（平板竖屏）下卡片改为纵向排列 */
@media (max-width: 640px) {
  .cards {
    flex-direction: column;
  }
}
</style>
