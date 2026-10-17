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

/** 右侧主内容区视图：主页插画 / 最近项目列表 / 关于与更新日志 */
type HomeView = 'home' | 'projects' | 'about'
const view = ref<HomeView>('home')

/** 左侧列表项：团队项目暂未开放，仅作占位展示 */
const comingSoonItems = [
  { label: '新建团队项目', icon: 'users' },
  { label: '打开团队项目', icon: 'folder-users' }
] as const

/**
 * 更新日志：按发布日期倒序，内容整理自真实提交历史
 */
const changelog: { date: string; title: string; items: string[] }[] = [
  {
    date: '2026-10-17',
    title: '界面字体',
    items: [
      '全站字体改为 HarmonyOS Sans SC，字体文件随工程打包，不依赖外部 CDN',
      '钢琴卷帘、时间轴标尺与波形画布上的文字同步改用该字体'
    ]
  },
  {
    date: '2026-10-17',
    title: '标点功能易用性改进',
    items: [
      '打点、自动卡点、上 / 下一个标点移到顶部工具栏，成为常驻快捷按钮，并显示当前标点数量',
      '「标点」下拉挪入同一分组，与快捷按钮用分隔线和其它功能隔开',
      '标尺右键菜单统一：右键标点弹出「重命名 / 删除标点」，右键波形片段新增「在此处打标点」，右键标尺空白可直接打点',
      '删除标点需在右键菜单中显式点击确认，避免右键即删的误操作'
    ]
  },
  {
    date: '2026-10-16',
    title: '音频剪辑与标点卡点',
    items: [
      '时间轴波形片段支持拖左右边缘修剪，右键菜单可「在播放头处分割 / 再制 / 删除」',
      '新增时间轴标记点（标点）：标尺双击空白处打点、双击旗标改名、拖动移位、右键删除，M 键在播放头处打点',
      '新增自动卡点：分析音频波形重音批量生成标记点，支持上一个 / 下一个跳转',
      '删除工程前弹出确认对话框，避免误触'
    ]
  },
  {
    date: '2026-10-15',
    title: '主页与界面布局',
    items: [
      '新增 Premiere Pro 风格启动欢迎页，打开项目直接在右栏显示最近工程',
      '界面布局改为可嵌套分割树，任意板块可插入到其他板块的上下左右',
      '音符检查器拆分为独立可编排板块'
    ]
  },
  {
    date: '2026-10-15',
    title: '钢琴卷帘体验优化',
    items: [
      '新增自绘横向与竖向滚动条，底部缩略导航条快速定位',
      '琴键列支持按住滑奏，修复点击后音符不释放的问题',
      '工具栏按语义分组收纳，显示与音阶折叠为下拉菜单',
      '拖动力度条时显示贯穿视口的水平参考线'
    ]
  },
  {
    date: '2026-10-15',
    title: '自动化、编组与音阶',
    items: [
      '自动化包络：音量 / 声像 / 混响发送曲线编辑，实时与导出听感一致',
      '轨道编组 / Bus：父子层级结构与环检测',
      '侧链压缩：包络跟随闪避，实时与离线导出统一',
      '音阶锁定：创建与拖拽自动吸附，支持一键量化'
    ]
  },
  {
    date: '2026-10-14',
    title: '自定义音源与乐器管理',
    items: [
      '自定义音源：导入采样拼装旋律 / 鼓组音源，采样存 IndexedDB',
      '乐器与音源管理器窗口，内置音色支持依次试听全部采样',
      '替换 TonePome 品牌 LOGO，新增全局弹窗过渡动画'
    ]
  },
  {
    date: '2026-10-14',
    title: '录音与音频轨',
    items: [
      '录音、音频轨波形编辑、MIDI 导入导出',
      '效果器链、撤销重做、布局编辑模式',
      '移动端触控手势修复'
    ]
  },
  {
    date: '2026-10-13',
    title: '首个版本',
    items: [
      '网页版库乐队 MVP：钢琴卷帘编曲、13 种音色、完整混音台',
      '力度编辑体系与专业音符编辑，PC / Pad 多端适配'
    ]
  }
]

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
  const target = state.savedProjects.find((p) => p.id === id)
  const name = target?.name ?? '未命名工程'
  // 删除前二次确认，避免误触
  if (!window.confirm(`确定要删除工程「${name}」吗？此操作无法撤销。`)) return
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
          <!-- 主页图标 -->
          <svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2.5 7L8 2.5 13.5 7" />
            <path d="M4 6.5V13.5h8V6.5" />
            <path d="M6.5 13.5v-4h3v4" />
          </svg>
          主页
        </button>

        <button class="menu-btn" @click="emit('new')">
          <!-- 新建图标 -->
          <svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          新建项目
        </button>
        <button
          class="menu-btn"
          :class="{ active: view === 'projects' }"
          @click="onOpenProjects"
        >
          <!-- 打开文件夹图标 -->
          <svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
            <path d="M2 7h12" opacity="0.5" />
          </svg>
          打开项目
        </button>

        <nav class="menu-list">
          <button
            v-for="item in comingSoonItems"
            :key="item.label"
            class="menu-item"
            :title="`${item.label}（即将推出）`"
            @click="onComingSoon"
          >
            <!-- 新建团队项目：双人图标 -->
            <svg v-if="item.icon === 'users'" class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="6" cy="5.5" r="2.2" />
              <path d="M2 13c.6-2.2 2.2-3.3 4-3.3s3.4 1.1 4 3.3" />
              <path d="M10.5 3.9a2.2 2.2 0 0 1 0 3.2M12 9.9c1 .5 1.7 1.5 2 3.1" />
            </svg>
            <!-- 打开团队项目：文件夹+人图标 -->
            <svg v-else class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3L8 4.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
              <circle cx="8" cy="8.2" r="1.2" />
              <path d="M6 11.5c.4-1 1.2-1.5 2-1.5s1.6.5 2 1.5" />
            </svg>
            {{ item.label }}
          </button>
        </nav>

        <!-- 最底下：关于（基本信息 + 更新日志） -->
        <button
          class="menu-item about-entry"
          :class="{ active: view === 'about' }"
          @click="view = 'about'"
        >
          <!-- 信息图标 -->
          <svg class="mi" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 7.2v3.6" />
            <circle cx="8" cy="5" r="0.4" fill="currentColor" stroke="none" />
          </svg>
          关于
        </button>
      </aside>

      <!-- 右侧主内容区（列表类视图从顶部向下排布） -->
      <main class="main" :class="{ 'top-align': view !== 'home' }">
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
        <template v-else-if="view === 'projects'">
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
              <button class="delete-btn" title="删除该工程" @click="onDeleteProject(item.id)">
                <!-- 垃圾桶图标 -->
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M2 4h12" />
                  <path d="M5.5 4V2.5h5V4" />
                  <path d="M3.5 4l.8 9.2a1 1 0 0 0 1 .8h5.4a1 1 0 0 0 1-.8L12.5 4" />
                  <path d="M6.5 6.8v4.4M9.5 6.8v4.4" />
                </svg>
              </button>
            </div>

            <p v-if="!state.savedProjects.length" class="empty">还没有保存过的工程</p>
          </div>
        </template>

        <!-- 关于：基本信息 + 更新日志 -->
        <template v-else>
          <h1 class="title">关于</h1>

          <div class="about">
            <!-- 基本信息 -->
            <section class="about-info">
              <div class="about-brand">TonePome</div>
              <p class="about-desc">
                网页版在线音乐编辑器（DAW）：钢琴卷帘编曲、音频轨与效果器、混音台，
                支持 MIDI 导入导出与 WAV 离线导出。纯前端实现，工程数据保存在本地浏览器中。
              </p>
              <p class="about-meta">Vue 3 · TypeScript · Tone.js · Canvas</p>
              <p class="about-meta">
                <a class="about-link" href="https://github.com/GrantPome/TonePome" target="_blank" rel="noopener">
                  github.com/GrantPome/TonePome
                </a>
              </p>
            </section>

            <!-- 更新日志 -->
            <section class="about-changelog">
              <h2 class="changelog-heading">更新日志</h2>
              <div v-for="entry in changelog" :key="entry.date + entry.title" class="changelog-entry">
                <div class="changelog-head">
                  <span class="changelog-date">{{ entry.date }}</span>
                  <span class="changelog-title">{{ entry.title }}</span>
                </div>
                <ul class="changelog-items">
                  <li v-for="item in entry.items" :key="item">{{ item }}</li>
                </ul>
              </div>
            </section>
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
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  font-size: 13px;
  text-align: left;
  color: var(--text);
  background: var(--panel-3);
  border: 1px solid var(--line);
  border-radius: 4px;
}

/* 菜单项图标：描边风格，与线稿插画一致 */
.mi {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  opacity: 0.85;
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
  display: flex;
  align-items: center;
  gap: 9px;
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

/* 当前视图对应的列表项高亮（如「关于」） */
.menu-item.active {
  color: var(--accent);
  background: var(--accent-soft);
}

/* 「关于」入口：固定在左栏最底下 */
.about-entry {
  margin-top: auto;
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

/* 列表类视图（打开项目 / 关于）：内容从标题下方开始，自上而下排布 */
.main.top-align {
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

/* 删除按钮：图标按钮，正方形居中 */
.delete-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-dim);
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

/* ---------------------------------------------------------------- 关于页 */

.about {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 22px;
  margin-top: 56px;
}

.about-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel-2);
}

.about-brand {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 1px;
}

.about-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--text-dim);
}

.about-meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
}

.about-link {
  color: var(--accent);
  text-decoration: none;
}

.about-link:hover {
  text-decoration: underline;
}

.changelog-heading {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.changelog-entry {
  padding: 10px 0 12px;
  border-bottom: 1px solid var(--line);
}

.changelog-entry:last-child {
  border-bottom: none;
}

.changelog-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 6px;
}

.changelog-date {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex: 0 0 auto;
}

.changelog-title {
  font-size: 13px;
  font-weight: 600;
}

.changelog-items {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.changelog-items li {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
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

  .about {
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
