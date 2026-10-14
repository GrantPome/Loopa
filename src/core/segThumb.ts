/**
 * 分段 Tab 的滑动指示块（组合式函数）
 *
 * 顶栏视图切换与「乐器与音源」管理器的页签共用同一套动效：
 * 选中项变化时，指示块先把「旧位置 → 新位置」的整段拉伸覆盖，
 * 再收拢到目标项，形成「先伸长、快到位时回缩」的流畅手感。
 */
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

export interface SegThumbApi {
  /** 指示块元素引用，模板上用 ref="thumbEl" 绑定 */
  thumbEl: Ref<HTMLElement | null>
  /** 绑定到每个 tab 按钮上的 ref 回调 */
  setTabRef: (el: unknown, key: string) => void
  /** 立即重新定位指示块（窗口尺寸变化时使用，不带动画） */
  reposition: () => void
}

export function useSegThumb(activeKey: () => string): SegThumbApi {
  /** 各 tab 按钮元素（键为 tab id） */
  const tabEls = ref<Record<string, HTMLElement | null>>({})
  const thumbEl = ref<HTMLElement | null>(null)

  // 指示块当前位置与宽度，作为两段式动画的起点
  let thumbLeft = 0
  let thumbWidth = 0
  let thumbReady = false
  let timer = 0

  function setTabRef(el: unknown, key: string): void {
    tabEls.value[key] = (el as HTMLElement | null) ?? null
  }

  function move(animate: boolean): void {
    const el = tabEls.value[activeKey()]
    const thumb = thumbEl.value
    if (!el || !thumb) return
    const nextLeft = el.offsetLeft
    const nextWidth = el.offsetWidth

    if (!animate || !thumbReady) {
      thumb.style.transition = 'none'
      thumb.style.left = `${nextLeft}px`
      thumb.style.width = `${nextWidth}px`
      thumbLeft = nextLeft
      thumbWidth = nextWidth
      thumbReady = true
      return
    }

    // 第一段：拉伸覆盖旧块与新块之间的整段
    const stretchedLeft = Math.min(thumbLeft, nextLeft)
    const stretchedWidth = Math.max(thumbLeft + thumbWidth, nextLeft + nextWidth) - stretchedLeft
    thumb.style.transition =
      'left 0.16s cubic-bezier(0.4, 0, 0.2, 1), width 0.16s cubic-bezier(0.4, 0, 0.2, 1)'
    thumb.style.left = `${stretchedLeft}px`
    thumb.style.width = `${stretchedWidth}px`
    thumbLeft = nextLeft
    thumbWidth = nextWidth

    // 第二段：收拢到目标 tab
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const t = thumbEl.value
      if (!t) return
      t.style.transition =
        'left 0.24s cubic-bezier(0.22, 1, 0.36, 1), width 0.24s cubic-bezier(0.22, 1, 0.36, 1)'
      t.style.left = `${nextLeft}px`
      t.style.width = `${nextWidth}px`
    }, 160)
  }

  watch(activeKey, () => move(true))

  function reposition(): void {
    move(false)
  }

  function onResize(): void {
    move(false)
  }

  onMounted(() => {
    window.addEventListener('resize', onResize)
    // 首帧后各 tab 已完成布局，定位指示块（不带动画）
    requestAnimationFrame(() => move(false))
    // 字体加载完成后文字宽度可能变化，重新定位一次
    if (document.fonts) document.fonts.ready.then(() => move(false)).catch(() => {})
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', onResize)
    window.clearTimeout(timer)
  })

  return { thumbEl, setTabRef, reposition }
}
