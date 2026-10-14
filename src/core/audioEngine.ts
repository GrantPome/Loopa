import * as Tone from 'tone'
import type { EqBand, Project, TimeSignature, Track, TrackEffect } from '@/types'
import {
  beatsPerBarOf,
  beatsToTicks,
  midiToNoteName,
  timeSignatureParts
} from '@/utils/music'
import { createInstrument, isDrumTrack, type InstrumentNode } from './instruments'
import { buildEffectChain, disposeEffectChain, type EffectChainItem } from './effects'
import { getCachedPcm, type PcmData } from './audioStore'

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
  /** MIDI 轨的合成器；音频轨为 null */
  instrument: InstrumentNode | null
  /** 统一信号入口 */
  entry: Tone.Gain
  effects: EffectChainItem[]
  /** 效果器链结构签名，用于判断是否需要重建 */
  effectSignature: string
  eq: Tone.EQ3
  panner: Tone.Panner
  gain: Tone.Gain
  send: Tone.Gain
  meter: Tone.Meter
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
  /** 已排期的音符事件 id，改动工程时用于批量清除 */
  private noteEventIds: number[] = []
  /** 节拍器循环事件 id */
  private metronomeId: number | null = null
  /** 音频片段播放器（每次重排整体重建） */
  private clipPlayers: { player: Tone.Player; gain: Tone.Gain }[] = []
  /** 采样键 → AudioBuffer 缓存，避免每次重排都重新拷贝整段采样 */
  private bufferCache = new Map<string, AudioBuffer>()

  private metronomeOn = false
  private countInOn = false
  private bpm = 120
  private timeSignature: TimeSignature = '4/4'

  /** 播放触发音符时的回调（用于虚拟键盘高亮） */
  onNoteOn: ((midi: number, trackId: string) => void) | null = null

  private get transport(): ReturnType<typeof Tone.getTransport> {
    return Tone.getTransport()
  }

  // ---------------------------------------------------------------- 初始化

  /** 用户首次点击后调用，激活 WebAudio 上下文并构建主输出链路 */
  async ensureReady(): Promise<void> {
    if (this.contextReady) return
    // WebAudio 规则：必须在用户手势之后才能 resume
    await Tone.start()
    this.buildGraph()
    this.contextReady = true
  }

  get isReady(): boolean {
    return this.contextReady
  }

  private buildGraph(): void {
    if (this.graphReady) return

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

    this.graphReady = true
  }

  // ------------------------------------------------------------ 轨道 / 混音

  /** 让音频通道与工程轨道保持一致（新增 / 删除 / 换音色 / 换轨道类型） */
  syncTracks(project: Project): void {
    if (!this.graphReady) return

    const alive = new Set(project.tracks.map((t) => t.id))
    for (const [id, channel] of Array.from(this.channels.entries())) {
      if (!alive.has(id)) {
        this.disposeChannel(channel)
        this.channels.delete(id)
      }
    }

    for (const track of project.tracks) {
      let channel = this.channels.get(track.id)
      // 轨道类型变化、或 MIDI 轨换音色 → 整个通道重建
      const needsRebuild =
        channel !== undefined &&
        (channel.kind !== track.kind ||
          (track.kind === 'midi' && channel.instrumentType !== track.instrument))
      if (needsRebuild && channel) {
        this.disposeChannel(channel)
        this.channels.delete(track.id)
        channel = undefined
      }
      if (!channel) {
        channel = this.createChannel(track)
        this.channels.set(track.id, channel)
      } else if (effectSignature(track.effects) !== channel.effectSignature) {
        this.rebuildEffects(channel, track)
      }
      this.applyMix(channel, track, project.tracks)
    }
  }

  /** 建立单条轨道的完整信号链 */
  private createChannel(track: Track): Channel {
    const gain = new Tone.Gain(1)
    gain.connect(this.dryBus)

    const send = new Tone.Gain(track.reverbSend)
    gain.connect(send)
    send.connect(this.reverbBus)

    const panner = new Tone.Panner(track.pan)
    panner.connect(gain)

    const eq = new Tone.EQ3({ low: track.eqLow, mid: track.eqMid, high: track.eqHigh })
    eq.connect(panner)

    const meter = new Tone.Meter({ normalRange: true, smoothing: 0.85 })
    gain.connect(meter)

    const entry = new Tone.Gain(1)
    const effects = buildEffectChain(track.effects)
    const channel: Channel = {
      id: track.id,
      kind: track.kind,
      instrumentType: track.instrument,
      instrument: null,
      entry,
      effects,
      effectSignature: effectSignature(track.effects),
      eq,
      panner,
      gain,
      send,
      meter
    }
    this.connectChain(channel)

    if (track.kind === 'midi') {
      const instrument = createInstrument(track.instrument)
      instrument.connect(entry)
      channel.instrument = instrument
    }

    return channel
  }

  /** 把入口 → 效果器链 → 均衡串起来 */
  private connectChain(channel: Channel): void {
    let node: Tone.ToneAudioNode = channel.entry
    for (const item of channel.effects) {
      node.connect(item.node.input)
      node = item.node.output
    }
    node.connect(channel.eq)
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

  private applyMix(channel: Channel, track: Track, tracks: Track[]): void {
    channel.gain.gain.value = computeTrackGain(track, tracks)
    channel.panner.pan.value = track.pan
    channel.eq.low.value = track.eqLow
    channel.eq.mid.value = track.eqMid
    channel.eq.high.value = track.eqHigh
    channel.send.gain.value = track.reverbSend
  }

  /** 单独设置某个均衡频段（供 UI 拖动时即时反馈） */
  setTrackEq(trackId: string, band: EqBand, value: number): void {
    const channel = this.channels.get(trackId)
    if (!channel) return
    // EqBand 用的是数据字段名，EQ3 用的是 low/mid/high，这里做一次映射
    channel.eq[EQ3_KEYS[band]].value = value
  }

  /** 单独设置混响发送量 */
  setTrackReverbSend(trackId: string, value: number): void {
    const channel = this.channels.get(trackId)
    if (!channel) return
    channel.send.gain.value = value
  }

  private disposeChannel(channel: Channel): void {
    channel.instrument?.dispose()
    disposeEffectChain(channel.effects)
    channel.entry.dispose()
    channel.eq.dispose()
    channel.panner.dispose()
    channel.gain.dispose()
    channel.send.dispose()
    channel.meter.dispose()
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

    for (const id of this.noteEventIds) t.clear(id)
    this.noteEventIds = []
    this.disposeClipPlayers()

    const ppq = t.PPQ

    for (const track of project.tracks) {
      const channel = this.channels.get(track.id)
      if (!channel) continue

      if (track.kind === 'audio') {
        this.scheduleClips(channel, track, ppq)
        continue
      }

      const drum = isDrumTrack(track.instrument)
      for (const region of track.regions) {
        for (const note of region.notes) {
          const at = beatsToTicks(region.start + note.start, ppq)
          const eventId = t.schedule((time: number) => {
            // 时长在触发瞬间按当前 BPM 计算，跟随变速
            const seconds = note.duration * (60 / t.bpm.value)
            if (!channel.instrument) return
            if (drum) channel.instrument.triggerAttackRelease(note.midi, seconds, time, note.velocity)
            else channel.instrument.triggerAttackRelease(midiToNoteName(note.midi), seconds, time, note.velocity)
            this.onNoteOn?.(note.midi, track.id)
          }, at)
          this.noteEventIds.push(eventId)
        }
      }
    }

    // 循环区间始终覆盖整个工程长度
    t.loopStart = 0
    t.loopEnd = beatsToTicks(project.bars * beatsPerBarOf(project.timeSignature), ppq)
  }

  /** 排期一条音频轨上的全部波形片段 */
  private scheduleClips(channel: Channel, track: Track, ppq: number): void {
    const t = this.transport
    const secondsPerBeat = 60 / t.bpm.value

    for (const clip of track.clips) {
      const buffer = this.clipBuffer(clip.key)
      if (!buffer) continue

      const player = new Tone.Player({
        url: buffer,
        fadeIn: clip.fadeIn * secondsPerBeat,
        fadeOut: clip.fadeOut * secondsPerBeat
      })
      const clipGain = new Tone.Gain(clip.gain)
      player.connect(clipGain)
      clipGain.connect(channel.entry)

      // sync() 让播放器跟随 Transport 的播放/暂停/循环，避免中途暂停后仍在出声
      player.sync().start(
        beatsToTicks(clip.start, ppq),
        clip.offset,
        clip.duration * secondsPerBeat
      )
      this.clipPlayers.push({ player, gain: clipGain })
    }
  }

  private disposeClipPlayers(): void {
    for (const item of this.clipPlayers) {
      item.player.unsync()
      item.player.dispose()
      item.gain.dispose()
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
    this.transport.bpm.value = bpm
  }

  /** 总输出音量（0~1） */
  setMasterVolume(volume: number): void {
    if (!this.graphReady) return
    this.masterGain.gain.value = volume
  }

  /** 混响返回量（0~1） */
  setReverbWet(wet: number): void {
    if (!this.graphReady) return
    this.reverbReturn.gain.value = wet
  }

  /** 总线限幅阈值（dB） */
  setLimiterThreshold(db: number): void {
    if (!this.graphReady) return
    this.limiter.threshold.value = db
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

    const atStart = this.getBeats() < 0.001
    if (this.countInOn && atStart) {
      const { count, interval } = this.countInPlan()
      const begin = Tone.now() + 0.12
      for (let i = 0; i < count; i += 1) {
        this.playClick(begin + i * interval, i === 0)
      }
      t.start(begin + count * interval)
    } else {
      t.start()
    }
  }

  pause(): void {
    this.transport.pause()
  }

  stop(): void {
    const t = this.transport
    t.stop()
    t.ticks = 0
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
  }

  // -------------------------------------------------------- 虚拟键盘实时弹奏

  /** 立即触发（用于屏幕键盘，使用 currentTime 降低延迟） */
  previewAttack(trackId: string, midi: number, velocity = 0.85): void {
    const channel = this.channels.get(trackId)
    if (!channel || !channel.instrument) return
    const now = Tone.getContext().currentTime
    if (isDrumTrack(channel.instrumentType)) channel.instrument.triggerAttack(midi, now, velocity)
    else channel.instrument.triggerAttack(midiToNoteName(midi), now, velocity)
  }

  previewRelease(trackId: string, midi: number): void {
    const channel = this.channels.get(trackId)
    if (!channel || !channel.instrument) return
    const now = Tone.getContext().currentTime
    if (isDrumTrack(channel.instrumentType)) channel.instrument.triggerRelease(midi, now)
    else channel.instrument.triggerRelease(midiToNoteName(midi), now)
  }

  /** 试听一段音频片段（波形编辑器里点击片段头部播放） */
  previewClip(trackId: string, key: string, offset: number, duration: number): void {
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

  // ------------------------------------------------------------ 离线渲染 WAV

  /**
   * 用 Tone.Offline 离线渲染整个工程，返回 AudioBuffer。
   * 注意：Tone.Offline 执行期间全局上下文会临时切换到离线上下文，
   * 回调里拿到的 transport 属于该离线上下文，因此节点与排期都在回调内创建。
   * 这里的信号链与实时播放保持一致（效果器 → 均衡 → 声像 → 推子 → 干声/混响总线 → 限幅）。
   */
  async renderToAudioBuffer(project: Project): Promise<AudioBuffer> {
    const bpb = beatsPerBarOf(project.timeSignature)
    const totalBeats = this.projectLengthBeats(project)
    const secondsPerBeat = 60 / project.bpm
    // 额外留 2 秒混响尾巴
    const duration = totalBeats * secondsPerBeat + 2

    const rendered = await Tone.Offline(({ transport }) => {
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

      /** 每条轨道的统一入口（合成器 / 片段播放器都汇入这里） */
      const entries = new Map<string, Tone.Gain>()
      const instruments = new Map<string, InstrumentNode>()

      for (const track of project.tracks) {
        const gain = new Tone.Gain(computeTrackGain(track, project.tracks))
        gain.connect(dryBus)

        const send = new Tone.Gain(track.reverbSend)
        gain.connect(send)
        send.connect(reverbBus)

        const panner = new Tone.Panner(track.pan)
        panner.connect(gain)

        const eq = new Tone.EQ3({ low: track.eqLow, mid: track.eqMid, high: track.eqHigh })
        eq.connect(panner)

        const entry = new Tone.Gain(1)
        entries.set(track.id, entry)

        // 与实时链路一致：入口 → 效果器链 → 均衡
        let node: Tone.ToneAudioNode = entry
        for (const effect of track.effects) {
          if (!effect.enabled) continue
          const chainItem = buildEffectChain([effect])[0]
          if (!chainItem) continue
          node.connect(chainItem.node.input)
          node = chainItem.node.output
        }
        node.connect(eq)

        if (track.kind === 'midi') {
          const instrument = createInstrument(track.instrument)
          instrument.connect(entry)
          instruments.set(track.id, instrument)
        }
      }

      for (const track of project.tracks) {
        const entry = entries.get(track.id)
        if (!entry) continue

        if (track.kind === 'audio') {
          for (const clip of track.clips) {
            const pcm = getCachedPcm(clip.key)
            if (!pcm) continue
            const player = new Tone.Player({
              url: pcmToAudioBuffer(pcm),
              fadeIn: clip.fadeIn * secondsPerBeat,
              fadeOut: clip.fadeOut * secondsPerBeat
            })
            const clipGain = new Tone.Gain(clip.gain)
            player.connect(clipGain)
            clipGain.connect(entry)
            player.sync().start(
              beatsToTicks(clip.start, transport.PPQ),
              clip.offset,
              clip.duration * secondsPerBeat
            )
          }
          continue
        }

        const instrument = instruments.get(track.id)
        if (!instrument) continue
        const drum = isDrumTrack(track.instrument)
        for (const region of track.regions) {
          for (const note of region.notes) {
            const at = beatsToTicks(region.start + note.start, transport.PPQ)
            const seconds = note.duration * secondsPerBeat
            transport.schedule((time) => {
              if (drum) instrument.triggerAttackRelease(note.midi, seconds, time, note.velocity)
              else instrument.triggerAttackRelease(midiToNoteName(note.midi), seconds, time, note.velocity)
            }, at)
          }
        }
      }

      transport.bpm.value = project.bpm
      transport.timeSignature = timeSignatureParts(project.timeSignature)
      transport.start(0)
    }, duration)

    const audioBuffer = rendered.get()
    if (!audioBuffer) throw new Error('离线渲染失败：未得到音频数据')
    return audioBuffer
  }
}

/** 把 PCM 采样打包成 AudioBuffer（WebAudio 的通用数据容器） */
function pcmToAudioBuffer(pcm: PcmData): AudioBuffer {
  const channelCount = pcm.channels.length
  const length = pcm.channels[0]?.length ?? 0
  const buffer = new AudioBuffer({
    numberOfChannels: Math.max(1, channelCount),
    length: Math.max(1, length),
    sampleRate: pcm.sampleRate
  })
  for (let c = 0; c < channelCount; c += 1) {
    buffer.getChannelData(c).set(pcm.channels[c])
  }
  return buffer
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
