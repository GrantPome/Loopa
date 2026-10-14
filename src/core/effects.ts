/**
 * 内置效果器
 *
 * 每种效果器都被包装成统一的 EffectNode 接口：
 * - input / output：接入轨道信号链的入口与出口
 * - setParam：按参数键实时更新（供 UI 拖动时即时反馈）
 * - dispose：释放底层节点
 *
 * 信号链位置：乐器 / 音频源 → 效果器链（按顺序串联）→ 均衡 → 声像 → 推子 → 总线
 * 实时播放与离线导出使用同一套构建逻辑，保证听感一致。
 */
import * as Tone from 'tone'
import type { EffectType, TrackEffect } from '@/types'
import { dbToGain } from '@/utils/audio'

export interface EffectNode {
  input: Tone.ToneAudioNode
  output: Tone.ToneAudioNode
  /** 按参数键更新数值；未知键忽略 */
  setParam(key: string, value: number): void
  dispose(): void
}

/** 按类型创建效果器节点，并用给定参数初始化 */
export function createEffectNode(type: EffectType, params: Record<string, number>): EffectNode {
  switch (type) {
    case 'compressor': {
      // Tone.Compressor 没有补偿增益，这里串联一个 Gain 节点实现 makeup
      const comp = new Tone.Compressor()
      const makeup = new Tone.Gain(1)
      comp.connect(makeup)
      const apply = (key: string, value: number): void => {
        if (key === 'threshold') comp.threshold.value = value
        else if (key === 'ratio') comp.ratio.value = value
        else if (key === 'attack') comp.attack.value = value
        else if (key === 'release') comp.release.value = value
        else if (key === 'makeup') makeup.gain.value = dbToGain(value)
      }
      Object.entries(params).forEach(([k, v]) => apply(k, v))
      return {
        input: comp,
        output: makeup,
        setParam: apply,
        dispose: () => {
          comp.dispose()
          makeup.dispose()
        }
      }
    }

    case 'delay': {
      const node = new Tone.FeedbackDelay()
      const apply = (key: string, value: number): void => {
        if (key === 'delayTime') node.delayTime.value = value
        else if (key === 'feedback') node.feedback.value = value
        else if (key === 'wet') node.wet.value = value
      }
      Object.entries(params).forEach(([k, v]) => apply(k, v))
      return {
        input: node,
        output: node,
        setParam: apply,
        dispose: () => node.dispose()
      }
    }

    case 'chorus': {
      // delayTime 单位是毫秒，需要换算成秒
      const node = new Tone.Chorus()
      node.start()
      const apply = (key: string, value: number): void => {
        if (key === 'frequency') node.frequency.value = value
        else if (key === 'depth') node.depth = value
        else if (key === 'delayTime') node.delayTime = value / 1000
        else if (key === 'wet') node.wet.value = value
      }
      Object.entries(params).forEach(([k, v]) => apply(k, v))
      return {
        input: node,
        output: node,
        setParam: apply,
        dispose: () => node.dispose()
      }
    }

    case 'distortion': {
      const node = new Tone.Distortion()
      const apply = (key: string, value: number): void => {
        if (key === 'distortion') node.distortion = value
        else if (key === 'wet') node.wet.value = value
      }
      Object.entries(params).forEach(([k, v]) => apply(k, v))
      return {
        input: node,
        output: node,
        setParam: apply,
        dispose: () => node.dispose()
      }
    }

    case 'filter': {
      const node = new Tone.Filter()
      const apply = (key: string, value: number): void => {
        if (key === 'frequency') node.frequency.value = value
        else if (key === 'Q') node.Q.value = value
        // mode：0 = 低通，1 = 高通
        else if (key === 'mode') node.type = value >= 0.5 ? 'highpass' : 'lowpass'
      }
      Object.entries(params).forEach(([k, v]) => apply(k, v))
      return {
        input: node,
        output: node,
        setParam: apply,
        dispose: () => node.dispose()
      }
    }

    case 'phaser':
    default: {
      const node = new Tone.Phaser()
      const apply = (key: string, value: number): void => {
        if (key === 'frequency') node.frequency.value = value
        else if (key === 'octaves') node.octaves = value
        else if (key === 'baseFrequency') node.baseFrequency = value
        else if (key === 'wet') node.wet.value = value
      }
      Object.entries(params).forEach(([k, v]) => apply(k, v))
      return {
        input: node,
        output: node,
        setParam: apply,
        dispose: () => node.dispose()
      }
    }
  }
}

/** 效果器链实例：包含节点与其对应的数据 id */
export interface EffectChainItem {
  id: string
  type: EffectType
  node: EffectNode
}

/**
 * 按轨道上的效果器列表构建链路。
 * 只构建 enabled 的效果器，但保留全部项（未启用的用 null 占位由调用方跳过）。
 * 这里直接返回启用项，便于按顺序串联。
 */
export function buildEffectChain(effects: TrackEffect[]): EffectChainItem[] {
  const items: EffectChainItem[] = []
  for (const effect of effects) {
    if (!effect.enabled) continue
    items.push({ id: effect.id, type: effect.type, node: createEffectNode(effect.type, effect.params) })
  }
  return items
}

/** 释放一整条效果器链 */
export function disposeEffectChain(items: EffectChainItem[]): void {
  items.forEach((item) => item.node.dispose())
}
