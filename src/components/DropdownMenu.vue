<script setup lang="ts">
/**
 * 通用下拉菜单（工具栏收纳用）
 *
 * 工具栏空间有限，同类功能收进一个下拉里比平铺一排按钮更好读。
 * 使用方式：把触发器文字交给 label，面板内容放进默认插槽，
 * 开关项 / 选择项 / 一次性操作都由调用方自行决定，组件不预设样式。
 *
 * 交互约定（与顶栏「文件」下拉保持一致）：
 * - 点击触发器展开 / 收起
 * - 点击面板与触发器之外的区域收起
 * - Esc 收起
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 触发器文字 */
    label: string
    /** 触发器是否高亮（如组内有任一开关处于打开状态） */
    active?: boolean
    /** 触发器悬停提示 */
    title?: string
    /** 面板宽度（px） */
    width?: number
    /** 面板是否靠右对齐（触发器贴近容器右缘时用） */
    alignRight?: boolean
  }>(),
  { active: false, title: '', width: 210, alignRight: false }
)

/** 面板是否展开 */
const open = ref(false)
const wrapEl = ref<HTMLElement | null>(null)

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

/** 点击外部收起：只在展开时判断，避免常驻开销 */
function onDocOutside(event: Event): void {
  if (!open.value) return
  const target = event.target as Node | null
  if (target && wrapEl.value && !wrapEl.value.contains(target)) close()
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) close()
}

onMounted(() => {
  // pointerdown（捕获阶段）负责真实鼠标 / 触摸的即时收起；
  // click 作为兜底，兼容只派发 click 的合成事件（脚本触发、部分自动化环境）
  window.addEventListener('pointerdown', onDocOutside, true)
  window.addEventListener('click', onDocOutside, true)
  window.addEventListener('keydown', onDocKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocOutside, true)
  window.removeEventListener('click', onDocOutside, true)
  window.removeEventListener('keydown', onDocKeydown)
})

/** 供调用方在「一次性操作」执行后主动收起面板 */
defineExpose({ close })
</script>

<template>
  <div ref="wrapEl" class="dd">
    <button
      class="dd-trigger"
      :class="{ active: open || active }"
      :title="props.title || label"
      @click="toggle"
    >
      {{ label }}<span class="caret">▾</span>
    </button>

    <div
      v-if="open"
      class="dd-panel"
      :style="{ width: props.width + 'px' }"
      :class="{ right: props.alignRight }"
    >
      <slot />
    </div>
  </div>
</template>

<style scoped>
.dd {
  position: relative;
}

.dd-trigger {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.caret {
  font-size: 9px;
  opacity: 0.75;
}

/* 面板：挂在下拉下方，盖住画布区域即可，无需 teleport */
.dd-panel {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 60;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  animation: dd-pop 0.14s cubic-bezier(0.22, 1, 0.36, 1);
}

.dd-panel.right {
  left: auto;
  right: 0;
}

@keyframes dd-pop {
  from {
    opacity: 0;
    transform: translateY(-5px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
