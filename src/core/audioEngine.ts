import * as Tone from 'tone'
import type {
  AutomationLane,
  AutomationParam,
  EqBand,
  InstrumentType,
  Project,
  TempoPoint,
  TimeSignature,
  Track,
  TrackEffect
} from '@/types'
import {
  beatsPerBarOf,
  beatsToTicks,
  bpmAtBeat,
  midiToNoteName,
  secondsBetweenBeats,
  tempoBreakpoints,
  timeSignatureParts
} from '@/utils/music'
import { dbToGain } from '@/utils/audio'
import { createInstrument, isDrumTrack, type InstrumentNode, type ResolvedCustomInstrument, type ResolvedSample } from './instruments'
import { buildEffectChain, disposeEffectChain, type EffectChainItem } from './effects'
import { getCachedPcm, hasCachedPcm, pcmToAudioBuffer } from './audioStore'

/**
 * 可被自动化驱动的音频参数的最小接口。
 * Tone 的 Param（gain / pan / EQ 频段）都满足这组方法，因此可以统一处理，
 * 不必为每个参数单独写一套排期逻辑。
 */
interface AutomatableParam {
  value: number
  setValueAtTime(value: number, time: number): unknown
  linearRampToValueAtTime(value: number, time: number): unknown
  cancelScheduledValues(time: number): unknown
  cancelAndHoldAtTime(time: number): unknown
}

/**
 * 仅在数值确有变化时写入参数。
 * Tone 的 value setter 内部是「cancelScheduledValues + setValueAtTime」，
 * 每次赋值都会往参数时间轴插入事件；对没有变化的参数反复赋值会让事件无限堆积，
 * 最终拖慢主线程并造成音频卡顿 / 杂音。
 */
function setParamValue(node: AutomatableParam, value: number): void {
  if (Math.abs(node.value - value) < 1e-6) return
  node.value = value
}

/**
 * 计算轨道的实际线性增益：
 * 1. Mute 直接为 0
 * 2. 只要工程里存在 Solo 轨道，未 Solo 的轨道静音
 */
export function computeTrackGain(track: Track, tracks: Track[]): number {
  if (track.mute) return 0
  const anySolo = tracks.some((t) => t.solo)
  if (anySolo && !track.solo) return 0
  return track.volume
}

/**
 * 一条轨道对应的音频通道：
 * 信号源 → 效果器链 → 均衡 → 声像 → 推子 → 主干声总线
 *                                  ↘ 混响发送 → 共享混响总线
 *                                  ↘ 电平表（旁路分析，不影响声音）
 *
 * 「信号源」对 MIDI 轨是内置合成器，对音频轨是波形片段播放器；
 * 两者都先汇入统一的 entry 节点，因此后续链路完全一致。
 */
interface Channel {
  id: string
  kind: Track['kind']
  instrumentType: Track['instrument']
  /** 自定义音源 id（仅 instrument === 'custom' 时有效） */
  customInstrumentId: string
  /**
   * 乐器签名：类型 / 自定义音源 id / 采样映射 / 采样是否已加载。
   * 任一变化都需要重建通道，保证新增采样后能立即发声。
   */
  instrumentSignature: string
  /** 是否按 MIDI 音号触发（鼓组为 true，旋律为 false） */
  drum: boolean
  /** 父编组轨 id：非空时推子输出汇入父编组的入口 */
  parentId: string
  /** MIDI 轨的合成器；音频轨为 null */
  instrument: InstrumentNode | null
  /** 统一信号入口 */
  entry: Tone.Gain
  effects: EffectChainItem[]
  /** 效果器链结构签名，用于判断是否需要重建 */
  effectSignature: string
  /** 侧链衰减节点：由源轨道包络驱动，插在效果器链之后、均衡之前 */
  duck: Tone.Gain
  eq: Tone.EQ3
  panner: Tone.Panner
  gain: Tone.Gain
  send: Tone.Gain
  meter: Tone.Meter
  /** 侧链当前衰减系数 0~1（1 表示不衰减），用于逐帧平滑 */
  sidechainEnv: number
}

/** 数据字段名 → EQ3 属性名的映射 */
const EQ3_KEYS: Record<EqBand, 'low' | 'mid' | 'high'> = {
  eqLow: 'low',
  eqMid: 'mid',
  eqHigh: 'high'
}

/** 效果器链结构签名：只有 id / 类型 / 启用状态变化才需要重建链路 */
function effectSignature(effects: TrackEffect[]): string {
  return effects.map((e) => `${e.id}:${e.type}:${e.enabled ? 1 : 0}`).join('|')
}

/**
 * 轨道乐器签名：
 * 内置音色直接取类型名；自定义音源把音源 id、类型、整体增益、
 * 每个采样的映射关系与「是否已加载进内存缓存」一并纳入，
 * 因此新增 / 删除采样、调整音号或采样完成预热都会触发通道重建。
 */
function instrumentSignature(track: Track, project: Project): string {
  if (track.kind !== 'midi') return ''
  if (track.instrument !== 'custom') return track.instrument
  const custom = project.customInstruments?.find((c) => c.id === track.customInstrumentId)
  if (!custom) return 'custom:missing'
  const parts = custom.samples.map(
    (s) => `${s.key}/${s.midi}/${s.rootMidi}/${s.gain}/${hasCachedPcm(s.key) ? 1 : 0}`
  )
  return `custom:${custom.id}:${custom.kind}:${custom.gain}:${parts.join(',')}`
}

/**
 * 音频引擎（单例）
 *
 * 设计要点：
 * - 所有音乐调度都交给 Tone.Transport，绝不使用 setTimeout 计时
 * - 音频上下文必须由用户手势触发 Tone.start() 后才可用
 * - 音符排期使用 tick 这种音乐时间单位，BPM 改变时自动重新缩放
 * - 混音总线：所有轨道汇入干声总线 + 共享混响总线，最后经限幅器输出
 */
class AudioEngine {
  /** 音频上下文是否已激活 */
  private contextReady = false
  /** 主输出链路是否已构建 */
  private graphReady = false

  /** 干声汇总总线（所有轨道推子后信号） */
  private dryBus!: Tone.Gain
  /** 共享混响总线（各轨发送量汇总后进入混响） */
  private reverbBus!: Tone.Freeverb
  /** 混响返回电平（决定混响在总输出中的占比） */
  private reverbReturn!: Tone.Gain
  /** 总音量推子 */
  private masterGain!: Tone.Gain
  /** 总线限幅器，防止总输出削波 */
  private limiter!: Tone.Limiter
  /** 总线电平表 */
  private masterMeter!: Tone.Meter

  private clickGain!: Tone.Gain
  private clickHi!: Tone.Synth
  private clickLo!: Tone.Synth

  private channels = new Map<string, Channel>()
  /** 最近一次同步的轨道列表：用于独奏判定、编组层级解析与侧链求值 */
  private trackList: Track[] = []
  /** 已排期的音符事件 id，改动工程时用于批量清除 */
  private noteEventIds: number[] = []
  /** 节拍器循环事件 id */
  private metronomeId: number | null = null
  /** 音频片段播放器（每次重排整体重建） */
  private clipPlayers: { player: Tone.Player; gain: Tone.Gain; pitch?: Tone.PitchShift }[] = []
  /** 采样键 → AudioBuffer 缓存，避免每次重排都重新拷贝整段采样 */
  private bufferCache = new Map<string, AudioBuffer>()
  /** 当前试听中的临时乐器（管理器里点「试听」时创建，播完自动释放） */
  private audition: { instrument: InstrumentNode; gain: Tone.Gain; timer: number } | null = null

  private metronomeOn = false
  private countInOn = false
  private bpm = 120
  private timeSignature: TimeSignature = '4/4'
  /** 当前工程的速度点表（scheduleProject 时随工程更新），供播放/跳转时锚定速度曲线 */
  private tempoPoints: TempoPoint[] = []
  /** 低音区音量补偿是否开启（默认开启，设置页可关） */
  private lowNoteBoost = true

  /** 播放触发音符时的回调（用于虚拟键盘高亮） */
  onNoteOn: ((midi: number, trackId: string) => void) | null = null

  private get transport(): ReturnType<typeof Tone.getTransport> {
    return Tone.getTransport()
  }

  // ---------------------------------------------------------------- 初始化

  /** 用户首次点击后调用，激活 WebAudio 上下文并构建主输出链路 */
  async ensureReady(): Promise<void> {
    // 上下文可能被浏览器自动挂起（播放停止一段时间后、电源管理、音频设备切换等），
    // 每次调用都检查并恢复，否则会出现「播放完再播放/弹琴键无声」的问题
    if (this.contextReady && Tone.getContext().state === 'running') return
    await this.resumeContext()
    this.buildGraph()
    this.contextReady = true
  }

  /**
   * 真正恢复 AudioContext 到 running 状态。
   * 直接调用 Tone.start()（即 context.resume()）在某些 Chrome 版本上可能返回
   * 但状态尚未真正变成 running，这里加一层验证 + 重试，确保恢复成功后才返回。
   */
  private async resumeContext(): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Tone.start()
      if (Tone.getContext().state === 'running') return
      // 状态还没变，等一小会儿再试（Chrome 的 resume 有时是异步的）
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  get isReady(): boolean {
    return this.contextReady
  }

  /** 音频上下文是否处于运行状态（浏览器会在后台/切换音频设备/省电时自动挂起） */
  get contextRunning(): boolean {
    return Tone.getContext().state === 'running'
  }

  /** 恢复被挂起的音频上下文；已运行或尚未构建链路时什么都不做 */
  async resume(): Promise<void> {
    if (!this.contextReady || this.contextRunning) return
    await this.resumeContext()
    // 上下文恢复后，把因挂起而卡住的 voice 全部释放掉，
    // 否则 PolySynth 复音池被占满，新音符无声
    if (this.graphReady) this.releaseAllVoices()
  }

  /**
   * 供心跳循环每帧调用：检测上下文是否被挂起，若是则异步恢复。
   * Chrome 在 Windows 上会因电源管理 / 音频设备空闲等原因自动挂起 AudioContext，
   * 即使没有切换窗口也会发生。挂起后 currentTime 冻结，所有排期事件无法触发，
   * 表现为「无声」；恢复时若有大量卡在旧时间点的事件，可能产生爆音。
   * 这里每帧检查一次，确保上下文始终处于 running 状态。
   */
  tickContextCheck(): void {
    if (!this.contextReady || this.contextRunning) return
    // 异步恢复，不阻塞 rAF 帧
    void this.resume()
  }

  private buildGraph(): void {
    if (this.graphReady) return

    // 监听上下文状态变化：一旦被浏览器挂起就标记下来，
    // 心跳循环会在下一帧尝试恢复；恢复后释放卡住的 voice
    const ctx = Tone.getContext()
    ctx.on('statechange', (state: string) => {
      if (state === 'running' && this.graphReady) {
        // 从挂起恢复后，释放可能因挂起而卡住的 voice
        this.releaseAllVoices()
      }
    })

    // 主输出：干声总线 + 混响总线 → 总音量 → 限幅器 → 扬声器
    this.dryBus = new Tone.Gain(1)
    this.reverbBus = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 })
    this.reverbReturn = new Tone.Gain(0.18)
    this.masterGain = new Tone.Gain(0.8)
    // 限幅器阈值 -1dB，既能防止削波又几乎听不出压缩痕迹
    this.limiter = new Tone.Limiter(-1)

    this.dryBus.connect(this.masterGain)
    this.reverbBus.connect(this.reverbReturn)
    this.reverbReturn.connect(this.masterGain)
    this.masterGain.connect(this.limiter)
    this.limiter.toDestination()

    // 总线电平表挂在限幅之后，反映最终输出电平
    this.masterMeter = new Tone.Meter({ normalRange: true, smoothing: 0.85 })
    this.limiter.connect(this.masterMeter)

    // 节拍器独立于主输出，避免被总音量推子影响
    this.clickGain = new Tone.Gain(0.6).toDestination()
    this.clickHi = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 }
    }).connect(this.clickGain)
    this.clickHi.volume.value = -8
    this.clickLo = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 }
    }).connect(this.clickGain)
    this.clickLo.volume.value = -14

    const t = this.transport
    t.bpm.value = this.bpm
    t.timeSignature = timeSignatureParts(this.timeSignature)

    // 循环回绕时重新锚定速度曲线：速度斜坡是按绝对时间排期的一次性事件，
    // 第二轮循环需要重新从第 0 拍铺一遍，否则回绕后会停留在最后一段的速度上
    t.on('loopEnd', (time: number) => {
      if (t.state !== 'started') return
      this.applyTempoMap(0, Math.max(time, Tone.now()))
    })

    this.graphReady = true
  }

  // ------------------------------------------------------------ 速度自动化

  /**
   * 把速度曲线排期到 Transport 的 bpm 参数上：
   * 在 atTime 处锚定 startBeat 上的瞬时速度，再对每个速度点按
   * 「梯形模型」算出的真实秒数做 linearRamp（随时间线性）。
   * Tone 的 TickParam 会对 bpm 斜坡做精确积分，拍位与时长相互自洽。
   */
  private applyTempoMap(startBeat: number, atTime?: number): void {
    if (!this.graphReady) return
    const param = this.transport.bpm
    const base = atTime ?? Tone.now()
    const target = bpmAtBeat(startBeat, this.tempoPoints, this.bpm)
    // 必须在取消排期之前读取当前速度：cancelScheduledValues 会清空参数时间轴，
    // 之后再读只能拿到构造时的初始速度
    const current = param.value
    param.cancelScheduledValues(0)
    if (Math.abs(current - target) < 0.01) {
      param.setValueAtTime(target, base)
    } else {
      // 与当前速度不同（播放中改速度、循环回绕）时用极短斜坡过渡，避免阶跃爆音
      param.setValueAtTime(current, base)
      param.linearRampToValueAtTime(target, base + 0.03)
    }
    for (const bp of tempoBreakpoints(this.tempoPoints, this.bpm)) {
      if (bp.beat <= startBeat) continue
      param.linearRampToValueAtTime(
        bp.bpm,
        base + secondsBetweenBeats(startBeat, bp.beat, this.tempoPoints, this.bpm)
      )
    }
  }

  // ------------------------------------------------------------ 轨道 / 混音

  /** 让音频通道与工程轨道保持一致（新增 / 删除 / 换音色 / 换轨道类型 / 改编组归属） */
  syncTracks(project: Project): void {
    if (!this.graphReady) return
    this.trackList = project.tracks

    const alive = new Set(project.tracks.map((t) => t.id))
    for (const [id, channel] of Array.from(this.channels.entries())) {
      if (!alive.has(id)) {
        this.disposeChannel(channel)
        this.channels.delete(id)
      }
    }

    for (const track of this.orderByDepth(project.tracks)) {
      let channel = this.channels.get(track.id)
      // 轨道类型变化、乐器（含自定义音源采样）变化、编组归属变化 → 整个通道重建
      const staleParent = channel !== undefined && channel.parentId !== this.normalizeParent(track)
      const needsRebuild =
        channel !== undefined &&
        (channel.kind !== track.kind ||
          staleParent ||
          (track.kind === 'midi' && channel.instrumentSignature !== instrumentSignature(track, project)))
      if (needsRebuild && channel) {
        this.disposeChannel(channel)
        this.channels.delete(track.id)
        channel = undefined
      }
      if (!channel) {
        channel = this.createChannel(track, project)
        this.channels.set(track.id, channel)
      } else if (effectSignature(track.effects) !== channel.effectSignature) {
        this.rebuildEffects(channel, track)
      }
      this.applyMix(channel, track, project.tracks)
    }
  }

  /** 归一化父编组 id：只接受真实存在的编组轨，其余视为无父级 */
  private normalizeParent(track: Track): string {
    if (!track.parentId) return ''
    const parent = this.trackList.find((t) => t.id === track.parentId)
    return parent && parent.kind === 'group' ? parent.id : ''
  }

  /**
   * 按编组层级排序（父在前、子在后），保证建立通道时父编组的 entry 已经存在。
   * 层级不会很深（编组通常只有一两层），这里用简单的迭代实现。
   */
  private orderByDepth(tracks: Track[]): Track[] {
    const byId = new Map(tracks.map((t) => [t.id, t]))
    const depthOf = (track: Track): number => {
      let depth = 0
      let cursor = byId.get(this.normalizeParent(track) || '')
      while (cursor && depth < 32) {
        depth += 1
        cursor = byId.get(this.normalizeParent(cursor) || '')
      }
      return depth
    }
    return [...tracks].sort((a, b) => depthOf(a) - depthOf(b))
  }

  /** 建立单条轨道的完整信号链 */
  private createChannel(track: Track, project: Project): Channel {
    const parentId = this.normalizeParent(track)
    const gain = new Tone.Gain(1)
    // 编组轨的子轨输出会汇入编组的 entry，这里先按当前数据连好，父级变化时整体重建
    gain.connect(this.routeTarget(parentId))

    const send = new Tone.Gain(track.reverbSend)
    gain.connect(send)
    send.connect(this.reverbBus)

    const panner = new Tone.Panner(track.pan)
    panner.connect(gain)

    const eq = new Tone.EQ3({ low: track.eqLow, mid: track.eqMid, high: track.eqHigh })
    eq.connect(panner)

    // 侧链衰减节点：默认不衰减（增益 1），由 rAF 心跳逐帧驱动
    const duck = new Tone.Gain(1)
    duck.connect(eq)

    const meter = new Tone.Meter({ normalRange: true, smoothing: 0.85 })
    gain.connect(meter)

    const entry = new Tone.Gain(1)
    const effects = buildEffectChain(track.effects)
    const custom = track.instrument === 'custom' ? this.resolveCustomInstrument(project, track.customInstrumentId) : null
    const customKind = project.customInstruments?.find((c) => c.id === track.customInstrumentId)?.kind
    const channel: Channel = {
      id: track.id,
      kind: track.kind,
      instrumentType: track.instrument,
      customInstrumentId: track.customInstrumentId,
      instrumentSignature: instrumentSignature(track, project),
      drum: isDrumTrack(track.instrument, customKind),
      parentId,
      instrument: null,
      entry,
      effects,
      effectSignature: effectSignature(track.effects),
      duck,
      eq,
      panner,
      gain,
      send,
      meter,
      sidechainEnv: 1
    }
    this.connectChain(channel)

    // 编组轨自身不发声：入口作为子轨的汇合点，不挂任何乐器
    if (track.kind === 'midi') {
      const instrument = createInstrument(track.instrument, custom)
      instrument.connect(entry)
      channel.instrument = instrument
    }

    return channel
  }

  /**
   * 解析一条轨道的输出目标：
   * 有父编组且该编组通道已存在时汇入编组的 entry，否则直接进主干声总线。
   * 注意父子必须按「父在前、子在后」的顺序建链，因此 syncTracks 会先按层级排序。
   */
  private routeTarget(parentId: string): Tone.Gain {
    if (!parentId) return this.dryBus
    const parent = this.channels.get(parentId)
    return parent ? parent.entry : this.dryBus
  }

  /**
   * 解析自定义音源：从内存缓存里取出各采样的 AudioBuffer。
   * 采样尚未预热完成时返回 null，此时乐器静音，等签名变化后会自动重建。
   */
  private resolveCustomInstrument(project: Project, id: string): ResolvedCustomInstrument | null {
    const custom = project.customInstruments?.find((c) => c.id === id)
    if (!custom || custom.samples.length === 0) return null
    const samples: ResolvedSample[] = []
    for (const sample of custom.samples) {
      const buffer = this.clipBuffer(sample.key)
      if (!buffer) continue
      samples.push({ midi: sample.midi, rootMidi: sample.rootMidi, gain: sample.gain, buffer })
    }
    if (samples.length === 0) return null
    return { kind: custom.kind, gain: custom.gain, samples }
  }

  /** 把入口 → 效果器链 → 侧链衰减 → 均衡串起来 */
  private connectChain(channel: Channel): void {
    let node: Tone.ToneAudioNode = channel.entry
    for (const item of channel.effects) {
      node.connect(item.node.input)
      node = item.node.output
    }
    node.connect(channel.duck)
  }

  /** 效果器链结构变化时重建（参数变化不重建，走原地更新） */
  private rebuildEffects(channel: Channel, track: Track): void {
    channel.entry.disconnect()
    disposeEffectChain(channel.effects)
    channel.effects = buildEffectChain(track.effects)
    channel.effectSignature = effectSignature(track.effects)
    this.connectChain(channel)
    // 新节点用数据里的当前参数初始化后再对齐一次，保证 UI 拖动过的值不丢
    this.pushEffectParams(channel, track)
  }

  /** 把工程里的效果器参数推给已存在的节点 */
  private pushEffectParams(channel: Channel, track: Track): void {
    for (const item of channel.effects) {
      const data = track.effects.find((e) => e.id === item.id)
      if (!data) continue
      for (const [key, value] of Object.entries(data.params)) {
        item.node.setParam(key, value)
      }
    }
  }

  /** 供 store 调用：效果器增删改后同步到引擎 */
  updateTrackEffects(track: Track): void {
    const channel = this.channels.get(track.id)
    if (!channel) return
    if (effectSignature(track.effects) !== channel.effectSignature) {
      this.rebuildEffects(channel, track)
    } else {
      this.pushEffectParams(channel, track)
    }
  }

  /** 实时更新单条轨道的音量/声像/均衡/发送（不需要重排音符） */
  updateMix(track: Track, tracks: Track[]): void {
    const channel = this.channels.get(track.id)
    if (!channel) return
    this.applyMix(channel, track, tracks)
  }

  /** 重新计算全部轨道的混音（Mute/Solo 变化会影响其他轨道） */
  updateAllMix(project: Project): void {
    for (const track of project.tracks) {
      const channel = this.channels.get(track.id)
      if (channel) this.applyMix(channel, track, project.tracks)
    }
  }

  /**
   * 把工程里的混音参数写到通道上。
   * 已被自动化曲线接管的参数不再写静态值，否则会与曲线打架（曲线的排期见 scheduleAutomation）。
   */
  private applyMix(channel: Channel, track: Track, tracks: Track[]): void {
    if (!this.hasAutomation(track, 'volume')) setParamValue(channel.gain.gain, computeTrackGain(track, tracks))
    if (!this.hasAutomation(track, 'pan')) setParamValue(channel.panner.pan, track.pan)
    if (!this.hasAutomation(track, 'eqLow')) setParamValue(channel.eq.low, track.eqLow)
    if (!this.hasAutomation(track, 'eqMid')) setParamValue(channel.eq.mid, track.eqMid)
    if (!this.hasAutomation(track, 'eqHigh')) setParamValue(channel.eq.high, track.eqHigh)
    if (!this.hasAutomation(track, 'reverbSend')) setParamValue(channel.send.gain, track.reverbSend)
  }

  // ------------------------------------------------------------ 自动化包络

  /** 数据字段名 → Tone 参数节点（自动化排期与静态赋值共用同一张映射） */
  private paramNode(channel: Channel, param: AutomationParam): AutomatableParam {
    switch (param) {
      case 'volume':
        return channel.gain.gain
      case 'pan':
        return channel.panner.pan
      case 'reverbSend':
        return channel.send.gain
      case 'eqLow':
        return channel.eq.low
      case 'eqMid':
        return channel.eq.mid
      default:
        return channel.eq.high
    }
  }

  /** 某参数是否存在自动化曲线（有曲线的参数不再用推子静态值覆盖） */
  private hasAutomation(track: Track, param: AutomationParam): boolean {
    const lane = track.automation?.find((l) => l.param === param)
    return Boolean(lane && lane.points.length >= 2)
  }

  /**
   * 清掉某条轨道已排期的自动化，并把参数复位到静态值。
   * 自动化的关键点排期在 scheduleProject 里重建，这里只负责「擦干净」。
   */
  private resetAutomation(channel: Channel, track: Track): void {
    const now = Tone.getContext().currentTime
    for (const param of ['volume', 'pan', 'reverbSend', 'eqLow', 'eqMid', 'eqHigh'] as AutomationParam[]) {
      const node = this.paramNode(channel, param)
      // 先「保持当前值」再取消后续排期：WebAudio 的 cancelScheduledValues 会把
      // 正在进行的斜坡整段撤掉，参数会瞬间跳回上一个台阶值，播放中编辑即爆音
      node.cancelAndHoldAtTime(now)
      if (this.hasAutomation(track, param)) continue
      // 与当前值几乎相同时不再赋值，避免参数时间轴被无意义的事件塞满
      if (Math.abs(node.value - track[param]) < 1e-6) continue
      node.linearRampToValueAtTime(track[param], now + 0.02)
    }
  }

  /** 供 store 调用：自动化曲线改动后立即复位参数（新的曲线等下一次 syncNow 排期） */
  updateTrackAutomation(track: Track): void {
    const channel = this.channels.get(track.id)
    if (!channel) return
    this.resetAutomation(channel, track)
    this.applyMix(channel, track, this.trackList.length > 0 ? this.trackList : [track])
  }

  /**
   * 按曲线排期（实时播放）：每个关键点用 Transport 的音乐时间触发一次参数写入，
   * 触发瞬间取 Tone 给的上下文时间，因此播放/循环/变速都不会错位。
   */
  private scheduleAutomation(channel: Channel, track: Track, ppq: number): void {
    for (const lane of track.automation ?? []) {
      this.scheduleLane(this.transport, this.paramNode(channel, lane.param), lane, ppq, this.noteEventIds)
    }
  }

  // ------------------------------------------------------------ 侧链压缩

  /**
   * 侧链衰减的实时驱动（由 store 的心跳循环每帧调用一次）。
   *
   * Tone 的压缩器没有外部侧链输入，这里采用「包络跟随 + 增益衰减」的做法：
   * 取侧链源轨道的实时电平，换算成应衰减的增益系数，再平滑地写到目标的 duck 节点上。
   * 平滑系数按 release 时间折算，保证不会出现阶跃式的不自然衰减。
   */
  updateSidechain(deltaMs: number): void {
    if (!this.graphReady) return
    for (const track of this.trackList) {
      const channel = this.channels.get(track.id)
      if (!channel) continue
      let target = 1
      let active = false
      for (const effect of track.effects) {
        if (!effect.enabled || effect.type !== 'compressor' || !effect.sidechain) continue
        const source = this.channels.get(effect.sidechain.sourceTrackId)
        if (!source) continue
        active = true
        const level = readMeter(source.meter)
        // amount 是最大衰减量（dB）：检测电平越高，衰减越接近 amount
        const reduction = Math.min(1, level * 2) * effect.sidechain.amount
        target = Math.min(target, dbToGain(-reduction))
      }
      // 没有侧链的轨道完全不碰参数：Tone 的 value setter 内部是 cancel+set，
      // 每次赋值都会往参数时间轴塞事件，逐帧写入会让事件无限堆积并拖慢主线程
      if (!active) {
        if (channel.sidechainEnv !== 1) {
          channel.sidechainEnv = 1
          channel.duck.gain.rampTo(1, 0.05)
        }
        continue
      }
      const timeConstant = this.sidechainRelease(track)
      // 一阶平滑：时间常数与帧间隔的比值决定每帧靠近目标的比例
      const alpha = 1 - Math.exp(-deltaMs / Math.max(1, timeConstant * 1000))
      const next = channel.sidechainEnv + (target - channel.sidechainEnv) * alpha
      // 变化极小时不写入，避免无意义的参数事件堆积
      if (Math.abs(next - channel.sidechainEnv) > 0.0005) {
        channel.sidechainEnv = next
        // 用 rampTo（内部 cancelAndHoldAtTime + linearRamp）替代直接赋值：
        // 直接 .value = next 每次都会 cancelScheduledValues + setValueAtTime，
        // 逐帧写入会让事件时间轴无限堆积，且阶跃式跳变产生拉链噪声
        channel.duck.gain.rampTo(next, 0.02)
      }
    }
  }

  /** 取该轨道侧链设置里最大的恢复时间，作为平滑时间常数 */
  private sidechainRelease(track: Track): number {
    let release = 0.2
    for (const effect of track.effects) {
      if (effect.sidechain) release = Math.max(release, effect.sidechain.release)
    }
    return release
  }

  /** 单独设置某个均衡频段（供 UI 拖动时即时反馈） */
  setTrackEq(trackId: string, band: EqBand, value: number): void {
    const channel = this.channels.get(trackId)
    if (!channel) return
    // EqBand 用的是数据字段名，EQ3 用的是 low/mid/high，这里做一次映射
    // 用 rampTo 替代直接赋值：拖动时每帧都会触发，直接赋值会产生拉链噪声
    const node = channel.eq[EQ3_KEYS[band]]
    if (Math.abs(node.value - value) < 1e-6) return
    node.rampTo(value, 0.01)
  }

  /** 单独设置混响发送量 */
  setTrackReverbSend(trackId: string, value: number): void {
    const channel = this.channels.get(trackId)
    if (!channel) return
    if (Math.abs(channel.send.gain.value - value) < 1e-6) return
    channel.send.gain.rampTo(value, 0.01)
  }

  /**
   * 自动化写入：绕过「有曲线的参数不写静态值」的规则，
   * 把当前拖动的值直接写到参数节点上，让播放中的推子立即可闻，
   * 随后由 store 把写入点合并进曲线并重新排期。
   */
  writeParamLive(trackId: string, param: AutomationParam, value: number): void {
    const channel = this.channels.get(trackId)
    if (!channel) return
    const node = this.paramNode(channel, param)
    const now = Tone.getContext().currentTime
    // 用极短斜坡过渡：直接赋值（内部是 cancel+set）会让参数阶跃跳变，产生爆音
    node.cancelAndHoldAtTime(now)
    node.linearRampToValueAtTime(value, now + 0.02)
  }

  private disposeChannel(channel: Channel): void {
    channel.instrument?.dispose()
    disposeEffectChain(channel.effects)
    channel.entry.dispose()
    channel.duck.dispose()
    channel.eq.dispose()
    channel.panner.dispose()
    channel.gain.dispose()
    channel.send.dispose()
    channel.meter.dispose()
  }

  /**
   * 释放全部轨道上正在发声的 voice。
   *
   * 为什么需要这个方法：
   * Tone.js 的 PolySynth 在达到 maxPolyphony 时不会偷取 voice，而是直接丢弃新音符。
   * 而 triggerAttackRelease 的 release 是通过 context.setTimeout 排期的，
   * 如果 AudioContext 被浏览器短暂挂起（Windows 电源管理、音频设备切换等，
   * 即使不切窗口也可能发生），setTimeout 不会触发，voice 就永远卡在 _activeVoices 里。
   * 24 个 voice 全部卡住后，后续所有音符被丢弃 → 无声。
   * 本方法在停止播放 / 恢复上下文时把卡住的 voice 全部释放掉。
   */
  releaseAllVoices(time?: number): void {
    const t = time ?? Tone.getContext().currentTime
    for (const channel of this.channels.values()) {
      channel.instrument?.releaseAll(t)
    }
  }

  // ------------------------------------------------------------ 电平表

  /** 读取某条轨道的电平（0~1，未就绪或未找到时返回 0） */
  getTrackLevel(trackId: string): number {
    const channel = this.channels.get(trackId)
    if (!channel) return 0
    return readMeter(channel.meter)
  }

  /** 读取总线输出电平（0~1） */
  getMasterLevel(): number {
    if (!this.graphReady) return 0
    return readMeter(this.masterMeter)
  }

  /** 限幅器是否正在工作（增益衰减超过 0.5dB 视为触发） */
  isLimiting(): boolean {
    if (!this.graphReady) return false
    return this.limiter.reduction < -0.5
  }

  // ---------------------------------------------------------------- 排期

  /**
   * 重新排期整个工程的音符与音频片段。
   * 使用 Transport 的音乐时间表示（tick），BPM 变化时无需重排。
   */
  scheduleProject(project: Project): void {
    if (!this.graphReady) return
    const t = this.transport
    this.trackList = project.tracks
    this.tempoPoints = project.tempoPoints ?? []

    for (const id of this.noteEventIds) t.clear(id)
    this.noteEventIds = []
    this.disposeClipPlayers()

    const ppq = t.PPQ

    for (const track of project.tracks) {
      const channel = this.channels.get(track.id)
      if (!channel) continue

      // 先把旧曲线从参数时间轴上撤掉，再排期新曲线
      this.resetAutomation(channel, track)
      this.scheduleAutomation(channel, track, ppq)

      // 编组轨自身不产生声音，只作为子轨的汇合点
      if (track.kind === 'group') continue

      if (track.kind === 'audio') {
        this.scheduleClips(channel, track, ppq)
        continue
      }

      const drum = channel.drum
      for (const region of track.regions) {
        for (const note of region.notes) {
          const at = beatsToTicks(region.start + note.start, ppq)
          const eventId = t.schedule((time: number) => {
            // 时长在触发瞬间按当前 BPM 计算，跟随变速
            const seconds = note.duration * (60 / t.bpm.value)
            if (!channel.instrument) return
            if (drum) channel.instrument.triggerAttackRelease(note.midi, seconds, time, note.velocity)
            else channel.instrument.triggerAttackRelease(midiToNoteName(note.midi), seconds, time, this.boostVelocity(note.midi, note.velocity))
            this.onNoteOn?.(note.midi, track.id)
          }, at)
          this.noteEventIds.push(eventId)
        }
      }
    }

    // 循环区间始终覆盖整个工程长度
    t.loopStart = 0
    t.loopEnd = beatsToTicks(project.bars * beatsPerBarOf(project.timeSignature), ppq)

    // 速度点可能被编辑过，按当前位置重新锚定速度曲线（播放中也会平滑重排）
    this.applyTempoMap(this.getBeats())
  }

  /** 排期一条音频轨上的全部波形片段（含 warp 对齐与半音移调） */
  private scheduleClips(channel: Channel, track: Track, ppq: number): void {
    for (const clip of track.clips) {
      const buffer = this.clipBuffer(clip.key)
      if (!buffer) continue

      // 片段在时间轴上占据的真实秒长与淡入淡出秒数（考虑速度曲线）
      const slotSeconds = secondsBetweenBeats(
        clip.start,
        clip.start + clip.duration,
        this.tempoPoints,
        this.bpm
      )
      const fadeSeconds = (beats: number): number =>
        secondsBetweenBeats(clip.start, clip.start + beats, this.tempoPoints, this.bpm)

      // warp：以变速率重采样铺满片段（工程改速度时片段跟随伸缩）；关闭则原速播放
      const sourceRemaining = Math.max(0.01, clip.sourceDuration - clip.offset)
      const rate = clip.warp && slotSeconds > 0.01 ? sourceRemaining / slotSeconds : 1

      const player = new Tone.Player({
        url: buffer,
        playbackRate: rate,
        fadeIn: clip.fadeIn > 0 ? fadeSeconds(clip.fadeIn) : 0,
        fadeOut: clip.fadeOut > 0 ? fadeSeconds(clip.fadeOut) : 0
      })
      const clipGain = new Tone.Gain(clip.gain)
      let head: Tone.ToneAudioNode = player
      let pitch: Tone.PitchShift | undefined
      // 半音移调：挂在片段增益之前（warp 的速率不会修正音高，两者效果叠加）
      if (clip.pitchShift !== 0) {
        pitch = new Tone.PitchShift({ pitch: Math.round(clip.pitchShift) })
        head.connect(pitch)
        head = pitch
      }
      head.connect(clipGain)
      clipGain.connect(channel.entry)

      // sync() 让播放器跟随 Transport 的播放/暂停/循环，避免中途暂停后仍在出声；
      // start 的 duration 语义是「源内容秒数」，Tone 内部会除以 playbackRate 换算墙钟时长
      player.sync().start(beatsToTicks(clip.start, ppq), clip.offset, clip.warp ? sourceRemaining : slotSeconds)
      this.clipPlayers.push({ player, gain: clipGain, pitch })
    }
  }

  private disposeClipPlayers(): void {
    for (const item of this.clipPlayers) {
      // 若片段正在发声，直接 dispose 会 abrupt 截断产生爆音，
      // 先加 8ms 淡出再释放
      const now = Tone.getContext().currentTime
      item.gain.gain.cancelScheduledValues(now)
      item.gain.gain.setValueAtTime(item.gain.gain.value, now)
      item.gain.gain.linearRampToValueAtTime(0, now + 0.008)
      const player = item.player
      const gain = item.gain
      const pitch = item.pitch
      setTimeout(() => {
        player.unsync()
        player.dispose()
        pitch?.dispose()
        gain.dispose()
      }, 20)
    }
    this.clipPlayers = []
  }

  /** 把 IndexedDB 里的采样转成 AudioBuffer（带缓存） */
  private clipBuffer(key: string): AudioBuffer | null {
    const cached = this.bufferCache.get(key)
    if (cached) return cached
    const pcm = getCachedPcm(key)
    if (!pcm) return null
    const buffer = pcmToAudioBuffer(pcm)
    this.bufferCache.set(key, buffer)
    return buffer
  }

  /** 采样数据被删除后清掉对应缓存 */
  dropBuffer(key: string): void {
    this.bufferCache.delete(key)
  }

  // ------------------------------------------------------------ 播放控制

  /** 工程总长度（拍） */
  projectLengthBeats(project: Project): number {
    return project.bars * beatsPerBarOf(project.timeSignature)
  }

  setBpm(bpm: number): void {
    this.bpm = bpm
    // 有速度点时直接写 value 会清掉斜坡，统一走 applyTempoMap 按当前位置重新锚定
    this.applyTempoMap(this.getBeats())
  }

  /** 更新速度曲线（工程速度点变化后调用，按当前位置重新锚定） */
  setTempoMap(points: TempoPoint[], baseBpm: number): void {
    this.tempoPoints = points
    this.bpm = baseBpm
    this.applyTempoMap(this.getBeats())
  }

  /** 总输出音量（0~1） */
  setMasterVolume(volume: number): void {
    if (!this.graphReady) return
    setParamValue(this.masterGain.gain, volume)
  }

  /** 混响返回量（0~1） */
  setReverbWet(wet: number): void {
    if (!this.graphReady) return
    setParamValue(this.reverbReturn.gain, wet)
  }

  /** 总线限幅阈值（dB） */
  setLimiterThreshold(db: number): void {
    if (!this.graphReady) return
    setParamValue(this.limiter.threshold, db)
  }

  /** 低音区音量补偿开关：人耳与小型扬声器对低频敏感度低，低音音符常听不清 */
  setLowNoteBoost(on: boolean): void {
    this.lowNoteBoost = on
  }

  /**
   * 低音区力度补偿：C4(60) 以下的旋律音符按音高逐级提升力度，
   * 越低补偿越多（最低约 +60%），抵消低频响度感知下降。
   * 鼓组按 MIDI 音号选音色，不做补偿。
   */
  private boostVelocity(midi: number, velocity: number): number {
    if (!this.lowNoteBoost || midi >= 60) return velocity
    return Math.min(1, velocity * (1 + ((60 - midi) / 48) * 0.8))
  }

  setTimeSignature(ts: TimeSignature): void {
    if (ts === this.timeSignature) return
    this.timeSignature = ts
    this.transport.timeSignature = timeSignatureParts(ts)
    this.rebuildMetronome()
  }

  setLoop(enabled: boolean): void {
    this.transport.loop = enabled
  }

  /** 节拍器开关 + 预备拍开关 */
  setMetronome(enabled: boolean, countIn: boolean): void {
    this.metronomeOn = enabled
    this.countInOn = countIn
    this.rebuildMetronome()
  }

  /**
   * 节拍器的点击单位取「拍号分母对应的音符」：
   * 4/4 → 四分音符、6/8 → 八分音符，
   * 这样复合拍子（如 7/8）的重音才会落在正确的位置上。
   */
  private rebuildMetronome(): void {
    if (!this.graphReady) return
    const t = this.transport
    if (this.metronomeId !== null) {
      t.clear(this.metronomeId)
      this.metronomeId = null
    }
    if (!this.metronomeOn) return

    const [numerator, denominator] = timeSignatureParts(this.timeSignature)
    const interval = denominator === 8 ? '8n' : '4n'
    const ticksPerClick = (t.PPQ * 4) / denominator
    const clicksPerBar = Math.max(1, Math.round((numerator * 4) / denominator))

    this.metronomeId = t.scheduleRepeat((time: number) => {
      const ticks = t.getTicksAtTime(time)
      const index = Math.round(ticks / ticksPerClick) % clicksPerBar
      this.playClick(time, index === 0)
    }, interval, 0)
  }

  /** 播放一次节拍器点击 */
  private playClick(time: number, accent: boolean): void {
    if (!this.graphReady) return
    const synth = accent ? this.clickHi : this.clickLo
    synth.triggerAttackRelease(accent ? 'C6' : 'G5', 0.03, time, accent ? 0.95 : 0.6)
  }

  /** 预备拍：一小节的点击次数与间隔（与当前拍号一致） */
  private countInPlan(): { count: number; interval: number } {
    const [numerator, denominator] = timeSignatureParts(this.timeSignature)
    const interval = (60 / this.bpm) * (4 / denominator)
    return { count: Math.max(1, numerator), interval }
  }

  /**
   * 播放。
   * 开启预备拍且位于起点时，先用音频时钟排一小节的点击，再把 Transport 的
   * 启动时间安排到预备拍结束的那一刻（不使用 setTimeout）。
   */
  async play(): Promise<void> {
    await this.ensureReady()
    const t = this.transport
    if (t.state === 'started') return

    // 播放前先释放可能卡住的 voice（上一次播放因上下文挂起导致 release 丢失），
    // 否则 PolySynth 复音池被占满后新音符会被丢弃
    this.releaseAllVoices()

    const atStart = this.getBeats() < 0.001
    if (this.countInOn && atStart) {
      const { count, interval } = this.countInPlan()
      const begin = Tone.now() + 0.12
      for (let i = 0; i < count; i += 1) {
        this.playClick(begin + i * interval, i === 0)
      }
      // 速度曲线锚定到走带真正启动的那一刻，避免预备拍期间斜坡提前走掉
      this.applyTempoMap(0, begin)
      t.start(begin)
    } else {
      this.applyTempoMap(this.getBeats())
      t.start()
    }
  }

  pause(): void {
    this.transport.pause()
    // 钉住当前速度：取消尚未触发的斜坡，防止暂停期间 bpm 参数继续漂移。
    // 注意必须「先读后取消」——cancelScheduledValues(0) 会清空参数时间轴，
    // 之后再读 param.value 只能拿到构造时的初始速度，速度会莫名跳回默认值
    const param = this.transport.bpm
    const current = param.value
    param.cancelScheduledValues(0)
    param.setValueAtTime(current, Tone.now())
  }

  stop(): void {
    const t = this.transport
    t.stop()
    t.ticks = 0
    // 停止时释放全部 voice：避免因上下文挂起导致的 triggerRelease 丢失，
    // 使 PolySynth 的 voice 池被卡住的 voice 占满，后续无声
    this.releaseAllVoices()
    // 回到起点后曲线尚未生效，把参数复位成推子上的静态值，避免停在曲线中途的数值
    this.resetAllAutomation()
    // 回到第 0 拍，速度曲线重新锚定到基准速度
    this.applyTempoMap(0)
  }

  /** 把全部轨道的自动化参数复位到静态值（停止 / 跳转时调用） */
  private resetAllAutomation(): void {
    for (const track of this.trackList) {
      const channel = this.channels.get(track.id)
      if (channel) this.resetAutomation(channel, track)
    }
  }

  /** 当前播放位置（拍），预备拍期间恒为 0 */
  getBeats(): number {
    const t = this.transport
    return Math.max(0, t.ticks / t.PPQ)
  }

  get isPlaying(): boolean {
    return this.transport.state === 'started'
  }

  /** 跳转到指定位置（拍） */
  seek(beats: number): void {
    this.transport.ticks = Math.max(0, beats) * this.transport.PPQ
    // 速度曲线随位置重新锚定，保证后续斜坡与新位置对齐
    this.applyTempoMap(Math.max(0, beats))
  }

  // -------------------------------------------------------- 虚拟键盘实时弹奏

  /** 立即触发（用于屏幕键盘，使用 currentTime 降低延迟） */
  previewAttack(trackId: string, midi: number, velocity = 0.85): void {
    // 上下文被挂起时 currentTime 已冻结，直接触发只会得到无声，先恢复再触发
    if (!this.contextRunning) {
      void this.ensureReady()
      return
    }
    const channel = this.channels.get(trackId)
    if (!channel || !channel.instrument) return
    // 加 5ms 偏移：上下文刚恢复时 currentTime 可能略有滞后，
    // 排期到过去会导致事件瞬间全部触发产生爆音
    const now = Tone.getContext().currentTime + 0.005
    if (channel.drum) channel.instrument.triggerAttack(midi, now, velocity)
    else channel.instrument.triggerAttack(midiToNoteName(midi), now, this.boostVelocity(midi, velocity))
  }

  previewRelease(trackId: string, midi: number): void {
    const channel = this.channels.get(trackId)
    if (!channel || !channel.instrument) return
    const now = Tone.getContext().currentTime + 0.005
    if (channel.drum) channel.instrument.triggerRelease(midi, now)
    else channel.instrument.triggerRelease(midiToNoteName(midi), now)
  }

  /**
   * 一次性试听（写谱时使用）：直接触发 attack + release。
   * 与虚拟键盘的 previewAttack 不同，这里不需要等待手动抬起，
   * 避免写下音符后声音一直挂着不释放。
   */
  previewNote(trackId: string, midi: number, velocity = 0.85): void {
    if (!this.contextRunning) {
      void this.ensureReady()
      return
    }
    const channel = this.channels.get(trackId)
    if (!channel || !channel.instrument) return
    const now = Tone.getContext().currentTime + 0.005
    if (channel.drum) channel.instrument.triggerAttackRelease(midi, 0.45, now, velocity)
    else channel.instrument.triggerAttackRelease(midiToNoteName(midi), 0.45, now, this.boostVelocity(midi, velocity))
  }

  /** 试听一个自定义音源采样（按原始音高原速播放） */
  previewSample(key: string): void {
    if (!this.graphReady) return
    if (!this.contextRunning) {
      void this.ensureReady()
      return
    }
    const buffer = this.clipBuffer(key)
    if (!buffer) return
    const player = new Tone.Player(buffer)
    player.connect(this.dryBus)
    player.onstop = () => player.dispose()
    player.start(Tone.now())
  }

  /** 试听一段音频片段（波形编辑器里点击片段头部播放） */
  previewClip(trackId: string, key: string, offset: number, duration: number): void {
    if (!this.contextRunning) {
      void this.ensureReady()
      return
    }
    const channel = this.channels.get(trackId)
    if (!channel || channel.kind !== 'audio') return
    const buffer = this.clipBuffer(key)
    if (!buffer) return
    const player = new Tone.Player(buffer)
    const gain = new Tone.Gain(1)
    player.connect(gain)
    gain.connect(channel.entry)
    player.start(Tone.now(), offset, duration)
    player.onstop = () => {
      player.dispose()
      gain.dispose()
    }
  }

  // -------------------------------------------------------- 乐器 / 音源试听

  /**
   * 试听任意音色（供「乐器与音源」管理器使用）：
   * 临时构建一个乐器节点接到干声总线，播放一小段示范乐句后自动释放。
   * 内置音色直接构建；自定义音源按工程数据解析出已解码的采样。
   * quick = true 时改用更短的示范乐句（供「依次试听全部音色」连播使用）。
   */
  previewVoice(type: InstrumentType, project: Project, customInstrumentId = '', quick = false): void {
    if (!this.graphReady) return
    if (!this.contextRunning) {
      void this.ensureReady()
      return
    }
    const custom =
      type === 'custom' ? this.resolveCustomInstrument(project, customInstrumentId) : null
    const drum = isDrumTrack(type, custom?.kind)

    // 同一时间只保留一条试听声音，避免连续点击叠成一片
    this.stopAudition()

    const instrument = createInstrument(type, custom)
    const gain = new Tone.Gain(1)
    instrument.connect(gain)
    gain.connect(this.dryBus)

    const now = Tone.getContext().currentTime
    if (drum) {
      // 一小段鼓点：底鼓 → 军鼓 → 闭合踩镲（连播时只取前三个，缩短时长）
      const hits: [number, number][] = quick
        ? [
            [36, 0],
            [38, 0.22],
            [42, 0.44]
          ]
        : [
            [36, 0],
            [38, 0.3],
            [42, 0.6],
            [46, 0.85],
            [49, 1.15]
          ]
      hits.forEach(([midi, offset]) => instrument.triggerAttackRelease(midi, 0.4, now + offset, 0.9))
    } else {
      // 上行分解和弦：完整模式 C4 E4 G4 C5，连播模式缩短为 C4 G4 C5
      const notes = quick ? [60, 67, 72] : [60, 64, 67, 72]
      const gap = quick ? 0.1 : 0.14
      const duration = quick ? 0.5 : 0.75
      notes.forEach((midi, index) =>
        instrument.triggerAttackRelease(midiToNoteName(midi), duration, now + index * gap, 0.85)
      )
    }

    // 等乐句自然收尾后再释放临时节点，避免声音被硬切断
    const lifetime = drum ? (quick ? 1100 : 2800) : quick ? 900 : 1900
    const timer = window.setTimeout(() => {
      // 期间若已开始新的试听，这里不再重复释放
      if (this.audition?.timer !== timer) return
      this.stopAudition()
    }, lifetime)
    this.audition = { instrument, gain, timer }
  }

  /** 停止并释放当前试听的临时乐器（关闭管理器时也应调用） */
  stopAudition(): void {
    if (!this.audition) return
    window.clearTimeout(this.audition.timer)
    this.audition.instrument.dispose()
    this.audition.gain.dispose()
    this.audition = null
  }

  // ------------------------------------------------------------ 离线渲染 WAV

  /**
   * 离线渲染时的一条轨道通道。
   * 与实时 Channel 结构一一对应，但只保留渲染需要的节点，
   * 这样「实时播放」和「导出 WAV」两条路径的信号链完全一致。
   */
  private buildOfflineChannel(
    track: Track,
    project: Project,
    destination: Tone.ToneAudioNode,
    reverbBus: Tone.Freeverb
  ): OfflineChannel {
    const gain = new Tone.Gain(computeTrackGain(track, project.tracks))
    gain.connect(destination)

    const send = new Tone.Gain(track.reverbSend)
    gain.connect(send)
    send.connect(reverbBus)

    const panner = new Tone.Panner(track.pan)
    panner.connect(gain)

    const eq = new Tone.EQ3({ low: track.eqLow, mid: track.eqMid, high: track.eqHigh })
    eq.connect(panner)

    const duck = new Tone.Gain(1)
    duck.connect(eq)

    const entry = new Tone.Gain(1)
    let node: Tone.ToneAudioNode = entry
    for (const effect of track.effects) {
      if (!effect.enabled) continue
      const chainItem = buildEffectChain([effect])[0]
      if (!chainItem) continue
      node.connect(chainItem.node.input)
      node = chainItem.node.output
    }
    node.connect(duck)

    let instrument: InstrumentNode | null = null
    let drum = false
    if (track.kind === 'midi') {
      const custom =
        track.instrument === 'custom'
          ? this.resolveCustomInstrument(project, track.customInstrumentId)
          : null
      const customKind = project.customInstruments?.find(
        (c) => c.id === track.customInstrumentId
      )?.kind
      instrument = createInstrument(track.instrument, custom)
      instrument.connect(entry)
      drum = isDrumTrack(track.instrument, customKind)
    }

    return { entry, duck, gain, send, panner, eq, instrument, drum }
  }

  /** 离线通道的参数节点映射（与实时 paramNode 一致，供自动化排期复用） */
  private offlineParamNode(channel: OfflineChannel, param: AutomationParam): AutomatableParam {
    switch (param) {
      case 'volume':
        return channel.gain.gain
      case 'pan':
        return channel.panner.pan
      case 'reverbSend':
        return channel.send.gain
      case 'eqLow':
        return channel.eq.low
      case 'eqMid':
        return channel.eq.mid
      default:
        return channel.eq.high
    }
  }

  /**
   * 排期一条轨道的内容（音符 / 音频片段）。
   * 离线渲染的主渲染与侧链预渲染都会复用这里，保证两遍渲染的内容完全一致。
   * 速度曲线由调用方在 transport 上排期，这里只负责内容与位置。
   */
  private scheduleOfflineContent(
    track: Track,
    channel: OfflineChannel,
    transport: ReturnType<typeof Tone.getTransport>,
    tempoPoints: TempoPoint[],
    baseBpm: number
  ): void {
    if (track.kind === 'audio') {
      for (const clip of track.clips) {
        const pcm = getCachedPcm(clip.key)
        if (!pcm) continue
        // 片段在时间轴上的真实秒长与淡入淡出（与实时播放同一套换算）
        const slotSeconds = secondsBetweenBeats(
          clip.start,
          clip.start + clip.duration,
          tempoPoints,
          baseBpm
        )
        const fadeSeconds = (beats: number): number =>
          secondsBetweenBeats(clip.start, clip.start + beats, tempoPoints, baseBpm)
        const sourceRemaining = Math.max(0.01, clip.sourceDuration - clip.offset)
        const rate = clip.warp && slotSeconds > 0.01 ? sourceRemaining / slotSeconds : 1

        const player = new Tone.Player({
          url: pcmToAudioBuffer(pcm),
          playbackRate: rate,
          fadeIn: clip.fadeIn > 0 ? fadeSeconds(clip.fadeIn) : 0,
          fadeOut: clip.fadeOut > 0 ? fadeSeconds(clip.fadeOut) : 0
        })
        const clipGain = new Tone.Gain(clip.gain)
        let head: Tone.ToneAudioNode = player
        if (clip.pitchShift !== 0) {
          const pitch = new Tone.PitchShift({ pitch: Math.round(clip.pitchShift) })
          head.connect(pitch)
          head = pitch
        }
        head.connect(clipGain)
        clipGain.connect(channel.entry)
        player.sync().start(
          beatsToTicks(clip.start, transport.PPQ),
          clip.offset,
          clip.warp ? sourceRemaining : slotSeconds
        )
      }
      return
    }
    if (!channel.instrument) return
    const instrument = channel.instrument
    const drum = channel.drum
    for (const region of track.regions) {
      for (const note of region.notes) {
        const at = beatsToTicks(region.start + note.start, transport.PPQ)
        // 音符时长按起始拍上的瞬时速度估算（速度变化中音符时长取起点速度）
        const seconds = note.duration * 60 / bpmAtBeat(region.start + note.start, tempoPoints, baseBpm)
        transport.schedule((time) => {
          if (drum) instrument.triggerAttackRelease(note.midi, seconds, time, note.velocity)
          else instrument.triggerAttackRelease(midiToNoteName(note.midi), seconds, time, this.boostVelocity(note.midi, note.velocity))
        }, at)
      }
    }
  }

  /** 按曲线把参数排期到给定参数节点上（实时与离线共用，只是节点来源不同） */
  private scheduleLane(
    transport: ReturnType<typeof Tone.getTransport>,
    node: AutomatableParam,
    lane: AutomationLane,
    ppq: number,
    eventIds: number[] | null
  ): void {
    if (lane.points.length < 2) return
    const first = lane.points[0]
    const anchor = transport.schedule((time: number) => {
      node.setValueAtTime(first.value, time)
    }, beatsToTicks(first.beat, ppq))
    if (eventIds) eventIds.push(anchor)
    for (let i = 1; i < lane.points.length; i += 1) {
      const point = lane.points[i]
      const id = transport.schedule((time: number) => {
        // WebAudio 的 linearRampToValueAtTime 会自动从上一事件值斜坡到目标值，
        // 同一时间点先 set 再 ramp 会产生阶跃爆音
        node.linearRampToValueAtTime(point.value, time)
      }, beatsToTicks(point.beat, ppq))
      if (eventIds) eventIds.push(id)
    }
  }

  /**
   * 预渲染「侧链源轨道」的电平包络。
   *
   * Tone 的压缩器没有原生侧链输入，所以实时播放时用逐帧包络跟随（见 updateSidechain）。
   * 离线导出时无法逐帧干预，于是先把源轨道单独渲染一遍，
   * 用 16 分音符为步长采样电平包络，再在主渲染里把它排期成 duck 节点的增益曲线，
   * 这样导出的 WAV 同样带有侧链闪避，与实时听感一致。
   * 工程里没有侧链时直接返回空表，不会产生额外渲染开销。
   */
  private async renderSidechainEnvelopes(
    project: Project,
    duration: number,
    fromBeat: number
  ): Promise<Map<string, { time: number; gain: number }[]>> {
    const result = new Map<string, { time: number; gain: number }[]>()
    // 源轨道 → 该源上最大的衰减量（多个目标共用同一个源时取最大）
    const sources = new Map<string, number>()
    for (const track of project.tracks) {
      for (const effect of track.effects) {
        if (!effect.enabled || !effect.sidechain) continue
        const id = effect.sidechain.sourceTrackId
        sources.set(id, Math.max(sources.get(id) ?? 0, effect.sidechain.amount))
      }
    }
    if (sources.size === 0) return result

    const tempoPoints = project.tempoPoints ?? []
    this.trackList = project.tracks

    for (const [sourceId, amount] of sources) {
      const source = project.tracks.find((t) => t.id === sourceId)
      if (!source) continue
      const samples: { time: number; gain: number }[] = []

      await Tone.Offline(({ transport }) => {
        const sink = new Tone.Gain(1).toDestination()
        const meter = new Tone.Meter({ normalRange: true, smoothing: 0.3 })
        sink.connect(meter)
        // 侧链源的单轨渲染：混响总线接了但不送回输出，只关心它的干声电平
        const spareReverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 })
        const channel = this.buildOfflineChannel(source, project, sink, spareReverb)
        this.scheduleOfflineContent(source, channel, transport, tempoPoints, project.bpm)

        transport.scheduleRepeat((time: number) => {
          const level = Math.min(1, readMeter(meter) * 2)
          samples.push({ time, gain: dbToGain(-level * amount) })
        }, '16n')

        // 与主渲染完全一致的速度曲线与起始位置，保证包络时间戳能对上
        scheduleTempoOffline(transport, tempoPoints, project.bpm, fromBeat)
        transport.timeSignature = timeSignatureParts(project.timeSignature)
        transport.ticks = fromBeat * transport.PPQ
        transport.start(0)
      }, duration)

      result.set(sourceId, samples)
    }
    return result
  }

  /**
   * 用 Tone.Offline 离线渲染整个工程，返回 AudioBuffer。
   * 注意：Tone.Offline 执行期间全局上下文会临时切换到离线上下文，
   * 回调里拿到的 transport 属于该离线上下文，因此节点与排期都在回调内创建。
   * 这里的信号链与实时播放保持一致（效果器 → 侧链衰减 → 均衡 → 声像 → 推子 → 编组/总线 → 限幅），
   * 自动化曲线、速度曲线与侧链闪避也会一并渲染进去。
   *
   * @param opts 导出选项：起止区间与采样率（缺省渲染整首、跟随浏览器采样率）
   */
  async renderToAudioBuffer(project: Project, opts: RenderOptions = {}): Promise<AudioBuffer> {
    const totalBeats = this.projectLengthBeats(project)
    const fromBeat = Math.max(0, opts.fromBeat ?? 0)
    const toBeat = Math.min(totalBeats, Math.max(fromBeat + 0.0625, opts.toBeat ?? totalBeats))
    const tempoPoints = project.tempoPoints ?? []
    // 额外留 2 秒混响尾巴
    const duration = secondsBetweenBeats(fromBeat, toBeat, tempoPoints, project.bpm) + 2
    const sidechainEnvelopes = await this.renderSidechainEnvelopes(project, duration, fromBeat)
    this.trackList = project.tracks

    const rendered = await Tone.Offline(
      ({ transport }) => {
        const dryBus = new Tone.Gain(1)
        const reverbBus = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 })
        const reverbReturn = new Tone.Gain(project.reverbWet)
        const master = new Tone.Gain(project.masterVolume)
        const limiter = new Tone.Limiter(project.masterLimiter)

        dryBus.connect(master)
        reverbBus.connect(reverbReturn)
        reverbReturn.connect(master)
        master.connect(limiter)
        limiter.toDestination()

        const channels = new Map<string, OfflineChannel>()
        // 按层级建链，保证挂到编组上的子轨能找到父级入口
        for (const track of this.orderByDepth(project.tracks)) {
          const parent = track.parentId ? channels.get(track.parentId) : undefined
          const destination = parent ? parent.entry : dryBus
          channels.set(track.id, this.buildOfflineChannel(track, project, destination, reverbBus))
        }

        for (const track of project.tracks) {
          const channel = channels.get(track.id)
          if (!channel) continue

          // 自动化曲线：与实时播放共用同一条曲线
          for (const lane of track.automation ?? []) {
            this.scheduleLane(transport, this.offlineParamNode(channel, lane.param), lane, transport.PPQ, null)
          }

          // 侧链闪避：把预渲染得到的包络写进 duck 增益
          const envelope = sidechainEnvelopes.get(track.id)
          if (envelope) {
            for (const item of envelope) channel.duck.gain.setValueAtTime(item.gain, item.time)
          }

          // 编组轨自身没有内容，只作为子轨的汇合点
          if (track.kind === 'group') continue
          this.scheduleOfflineContent(track, channel, transport, tempoPoints, project.bpm)
        }

        // 速度曲线（与实时播放同一模型）：锚定第 0 拍，斜坡落在各速度点的绝对秒上
        scheduleTempoOffline(transport, tempoPoints, project.bpm, fromBeat)
        transport.timeSignature = timeSignatureParts(project.timeSignature)
        // 直接把 Transport 定位到导出起点（tick），避免用秒偏移与速度曲线错位
        transport.ticks = fromBeat * transport.PPQ
        transport.start(0)
      },
      duration,
      2,
      opts.sampleRate
    )

    const audioBuffer = rendered.get()
    if (!audioBuffer) throw new Error('离线渲染失败：未得到音频数据')
    return audioBuffer
  }
}

/** 离线导出选项 */
export interface RenderOptions {
  /** 起始拍（含），缺省 0 */
  fromBeat?: number
  /** 结束拍（不含其后的内容），缺省工程末尾 */
  toBeat?: number
  /** 目标采样率（Hz），缺省跟随浏览器 */
  sampleRate?: number
}

/**
 * 在离线 Transport 上排期速度曲线：
 * 第 0 拍锚定基准速度，每个速度点按「梯形模型」的真实秒数做线性斜坡；
 * fromBeat 之后的曲线已经隐含在绝对秒里，无需再次偏移。
 */
function scheduleTempoOffline(
  transport: ReturnType<typeof Tone.getTransport>,
  tempoPoints: TempoPoint[],
  baseBpm: number,
  fromBeat: number
): void {
  transport.bpm.setValueAtTime(bpmAtBeat(0, tempoPoints, baseBpm), 0)
  for (const bp of tempoBreakpoints(tempoPoints, baseBpm)) {
    if (bp.beat <= 0) continue
    transport.bpm.linearRampToValueAtTime(
      bp.bpm,
      secondsBetweenBeats(0, bp.beat, tempoPoints, baseBpm)
    )
  }
  void fromBeat
}

/** 离线渲染用的轨道通道（与实时 Channel 对应的最小集合） */
interface OfflineChannel {
  entry: Tone.Gain
  duck: Tone.Gain
  gain: Tone.Gain
  /** 混响发送量节点：自动化「混响发送」直接写它的 gain */
  send: Tone.Gain
  panner: Tone.Panner
  eq: Tone.EQ3
  instrument: InstrumentNode | null
  drum: boolean
}

/** 读取电平表数值并归一化到 0~1（normalRange 模式下已是 0~1，这里再做一次保护） */
function readMeter(meter: Tone.Meter): number {
  const raw = meter.getValue()
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!Number.isFinite(value)) return 0
  // normalRange: true 时 value 已经是 0~1；若被平滑成极小值则视为静音
  return Math.max(0, Math.min(1, value))
}

let engineInstance: AudioEngine | null = null

/** 获取音频引擎单例 */
export function getAudioEngine(): AudioEngine {
  if (!engineInstance) engineInstance = new AudioEngine()
  return engineInstance
}

export type { AudioEngine }
