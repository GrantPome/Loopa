<script setup lang="ts">
/**
 * 应用主页（启动欢迎页）
 * Premiere Pro 风格欢迎页布局：
 * - 左侧菜单：主页 / 新建项目 / 打开项目，下方列表为团队项目入口（占位，即将推出）
 * - 右侧主内容区：
 *   - 主页：顶部大标题「欢迎使用 TonePome」，中间为音乐制作相关的简约线稿图标
 *     （钢琴键 / 音符 / 波形），下方是「编辑、效果和导出」标语
 *   - 新建项目：右栏列出「新建空白项目」「示例音频」与「导入音频 / 工程 JSON / MIDI」入口
 *   - 打开项目：右侧直接展示最近保存的工程列表，可打开 / 重命名 / 导出 JSON / 删除，不再使用弹窗
 * - 仅负责入口跳转：新建 → 新建工程并进入编辑器；加载工程 → 载入后进入编辑器
 * 复用项目现有主题令牌（--bg / --panel / --accent），深色暗色 UI，PC / 移动端自适应。
 */
import { ref } from 'vue'
import { createDemoAudioFile } from '@/core/demoAudio'
import {
  deleteSavedProject,
  exportSavedProjectJson,
  importAudioFile,
  importMidiFile,
  importProjectJson,
  loadProjectById,
  newProject,
  renameSavedProject,
  state
} from '@/core/store'

const emit = defineEmits<{ (e: 'enter'): void; (e: 'history'): void }>()

/** 右侧主内容区视图：主页插画 / 新建项目 / 最近项目列表 / 关于与更新日志 */
type HomeView = 'home' | 'create' | 'projects' | 'about'
const view = ref<HomeView>('home')

/** 新建项目的三种导入入口（空白项目直接走 emit('new')） */
const audioInput = ref<HTMLInputElement | null>(null)
const jsonInput = ref<HTMLInputElement | null>(null)
const midiInput = ref<HTMLInputElement | null>(null)

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
    title: '问题修复',
    items: [
      '修复播放中通过「文件 → 返回主页」回到主页后音乐仍继续播放的问题：返回主页时自动暂停走带；录音中返回则先结束录音落盘'
    ]
  },
  {
    date: '2026-10-17',
    title: '内置示例音频',
    items: [
      '「新建项目」新增「示例音频」入口：一键新建工程并载入内置示范音频',
      '示范音频由代码实时合成（4 小节 @120 BPM：鼓组 + 贝斯 + 和弦 + 旋律），导出为 WAV 后走与用户上传文件完全相同的导入流程',
      '鼓点落在整齐的拍点上，可直接用来体验波形修剪、分割与自动卡点'
    ]
  },
  {
    date: '2026-10-17',
    title: '主页新建与工程管理',
    items: [
      '「新建项目」改为在右栏选择入口：新建空白项目，或直接导入音频 / 工程 JSON / MIDI',
      '「打开项目」列表支持重命名工程与导出该工程为 JSON 文件',
      '主页显式声明品牌字体，不再只依赖全站样式继承'
    ]
  },
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

// ---------------------------------------------------------------- 新建项目

/** 空白工程：新建后直接进入编辑器 */
function onCreateBlank(): void {
  newProject()
  emit('enter')
}

/** 新建空白工程后导入音频文件（导入会自动创建音频轨与波形片段） */
async function onCreateFromAudio(): Promise<void> {
  const file = audioInput.value?.files?.[0]
  if (!file) return
  newProject()
  await importAudioFile(file)
  emit('enter')
  if (audioInput.value) audioInput.value.value = ''
}

/**
 * 新建空白工程后导入内置示例音频。
 * 示例音频由代码实时合成并编码成 WAV，再走与用户上传文件完全相同的导入流程，
 * 保证「示例音频」与手动导入的表现一致。
 */
async function onCreateFromDemo(): Promise<void> {
  newProject()
  state.project.name = '示例音频示范'
  state.statusText = '正在生成内置示例音频…'
  await importAudioFile(createDemoAudioFile())
  emit('enter')
}

/** 新建空白工程后导入 MIDI 文件（会继承文件里的速度与拍号） */
async function onCreateFromMidi(): Promise<void> {
  const file = midiInput.value?.files?.[0]
  if (!file) return
  newProject()
  await importMidiFile(file)
  emit('enter')
  if (midiInput.value) midiInput.value.value = ''
}

/** 导入工程 JSON：直接用文件内容替换当前工程，失败则停留在本页不进入编辑器 */
async function onCreateFromJson(): Promise<void> {
  const file = jsonInput.value?.files?.[0]
  if (!file) return
  // 导入成功时工程对象会被整体替换，用它判断是否进入编辑器（失败只写状态栏提示）
  const before = state.project
  await importProjectJson(file)
  if (jsonInput.value) jsonInput.value.value = ''
  if (state.project !== before) emit('enter')
}

// ---------------------------------------------------------------- 最近项目列表

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

/** 重命名历史工程 */
function onRenameProject(id: string, current: string): void {
  const next = window.prompt('工程名称', current)
  if (next === null) return
  renameSavedProject(id, next)
}

/** 导出历史工程为 JSON 文件 */
function onExportProject(id: string): void {
  exportSavedProjectJson(id)
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

        <button class="menu-btn" :class="{ active: view === 'create' }" @click="view = 'create'">
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

        <!-- 新建项目：右栏列出「空白项目」与三种导入方式，先选再进编辑器 -->
        <template v-else-if="view === 'create'">
          <h1 class="title">新建项目</h1>

          <div class="create-list">
            <button class="create-card" @click="onCreateBlank">
              <!-- 空白文档图标 -->
              <svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M6 3.5h7.5L18 8v12.5H6z" />
                <path d="M13.5 3.5V8H18" />
                <path d="M12 11.5v5M9.5 14h5" />
              </svg>
              <span class="c-title">新建空白项目</span>
              <span class="c-desc">从零开始，默认一条钢琴轨，可随后自由加轨</span>
            </button>

            <!-- 内置示例音频：整行宽卡片，突出「开箱即用」的示范入口 -->
            <button class="create-card wide" @click="onCreateFromDemo">
              <!-- 音符 + 波形图标 -->
              <svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10 16.5V6l7-1.6v10.4" />
                <circle cx="7.5" cy="17.5" r="2.5" />
                <circle cx="17" cy="15" r="2.5" />
              </svg>
              <span class="c-title">
                示例音频
                <span class="c-tag">内置</span>
              </span>
              <span class="c-desc">
                一键新建工程并载入内置示范音频：4 小节 120 BPM 的鼓组 + 贝斯 + 和弦 + 旋律，
                可直接体验波形编辑、修剪与自动卡点
              </span>
            </button>

            <button class="create-card" @click="audioInput?.click()">
              <!-- 波形图标 -->
              <svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12h2M8 8v8M12 5v14M16 9v6M20 11v2" />
              </svg>
              <span class="c-title">导入音频</span>
              <span class="c-desc">新建工程并载入 wav / mp3 等音频文件为波形片段</span>
            </button>

            <button class="create-card" @click="jsonInput?.click()">
              <!-- 工程 JSON 图标 -->
              <svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 5c-2 0-2.5 1.5-2.5 3.5S5 11 5 12s1.5 1.5 1.5 3.5S7 19 9 19" />
                <path d="M15 5c2 0 2.5 1.5 2.5 3.5S19 11 19 12s-1.5 1.5-1.5 3.5S17 19 15 19" />
              </svg>
              <span class="c-title">导入工程 JSON</span>
              <span class="c-desc">用之前导出的 .json 工程文件继续编辑</span>
            </button>

            <button class="create-card" @click="midiInput?.click()">
              <!-- MIDI 音符图标 -->
              <svg class="ci" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <path d="M8.5 4v10M12 4v10M15.5 4v10M4 14h16" />
              </svg>
              <span class="c-title">导入 MIDI</span>
              <span class="c-desc">新建工程并从 .mid 文件载入 MIDI 轨道，沿用它自带的速度与拍号</span>
            </button>
          </div>
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
              <button
                class="icon-btn"
                title="重命名该工程"
                @click="onRenameProject(item.id, item.name)"
              >
                <!-- 铅笔图标 -->
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M10.5 2.5l3 3-8 8-3.5.5.5-3.5z" />
                  <path d="M9.5 3.5l3 3" />
                </svg>
              </button>
              <button
                class="icon-btn"
                title="导出该工程为 JSON 文件"
                @click="onExportProject(item.id)"
              >
                <!-- 下载图标 -->
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M8 2.5v8" />
                  <path d="M4.5 7.5L8 11l3.5-3.5" />
                  <path d="M3 13h10" />
                </svg>
              </button>
              <button class="icon-btn danger" title="删除该工程" @click="onDeleteProject(item.id)">
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

    <!-- 新建项目的隐藏文件选择框：点卡片时由脚本触发 -->
    <input ref="audioInput" type="file" accept="audio/*" class="hidden-file" @change="onCreateFromAudio" />
    <input ref="jsonInput" type="file" accept="application/json,.json" class="hidden-file" @change="onCreateFromJson" />
    <input ref="midiInput" type="file" accept="audio/midi,.mid,.midi" class="hidden-file" @change="onCreateFromMidi" />
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
  /* 主页也显式指定品牌字体：不依赖继承，防止宿主样式差异导致回退到系统字体 */
  font-family: 'HarmonyOS Sans SC', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
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

/* ---------------------------------------------------------------- 新建项目 */

.create-list {
  align-self: stretch;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 56px;
}

/* 选项卡片：左图标右文案，整块可点 */
.create-card {
  display: grid;
  grid-template-columns: 34px 1fr;
  grid-template-rows: auto auto;
  column-gap: 12px;
  row-gap: 3px;
  align-items: center;
  padding: 14px 16px;
  text-align: left;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
}

.create-card:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--accent);
}

.ci {
  grid-row: 1 / 3;
  width: 26px;
  height: 26px;
  color: var(--text-dim);
}

.create-card:hover .ci {
  color: var(--accent);
}

/* 整行宽卡片：用于「示例音频」这类需要更完整说明的入口 */
.create-card.wide {
  grid-column: 1 / -1;
}

.c-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

/* 「内置」小标签：标明该素材随应用一起打包，无需外部文件 */
.c-tag {
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent);
  border-radius: 999px;
}

.c-desc {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-dim);
}

.hidden-file {
  display: none;
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

/* 列表项里的图标按钮：正方形居中 */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--text-dim);
}

.icon-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

/* 危险操作（删除）：悬停转为告警红 */
.icon-btn.danger:hover:not(:disabled) {
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

  /* 新建项目：窄屏改单列，避免卡片文字换行过挤 */
  .create-list {
    grid-template-columns: 1fr;
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
