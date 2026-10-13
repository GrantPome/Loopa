import * as Tone from 'tone'
import type { EqBand, Project, Track, TimeSignature } from '@/types'
import { beatsPerBarOf, beatsToTransportTime, midiToNoteName } from '@/utils/music'
import { createInstrument, isDrumTrack, type InstrumentNode } from './instruments'

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
 * 乐器 → 均衡 → 声像 → 推子 → 主干声总线
 *                          ↘ 混响发送 → 共享混响总线
 *                          ↘ 电平表（旁路分析，不影响声音）
 */
interface Channel {
  id: string
  instrument: Track['instrument']
  node: InstrumentNode
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

/**
 * 音频引擎（单例）
 *
 * 设计要点：
 * - 所有音乐调度都交给 Tone.Transport，绝不使用 setTimeout 计时
 * - 音频上下文必须由用户手势触发 Tone.start() 后才可用
 * - 音符排期使用 "小节:拍:十六分" 相对时间，BPM 改变时自动重新缩放
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
    t.timeSignature = beatsPerBarOf(this.timeSignature)

    this.graphReady = true
  }

  // ------------------------------------------------------------ 轨道 / 混音

  /** 让音频通道与工程轨道保持一致（新增 / 删除 / 换音色） */
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
      // 换音色 = 重建乐器节点
      if (channel && channel.instrument !== track.instrument) {
        this.disposeChannel(channel)
        this.channels.delete(track.id)
        channel = undefined
      }
      if (!channel) {
        channel = this.createChannel(track)
        this.channels.set(track.id, channel)
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

    const node = createInstrument(track.instrument)
    node.connect(eq)

    return { id: track.id, instrument: track.instrument, node, eq, panner, gain, send, meter }
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
    channel.node.dispose()
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
   * 重新排期整个工程的音符。
   * 使用 Transport 的相对时间表示，BPM 变化时无需重排。
   */
  scheduleProject(project: Project): void {
    if (!this.graphReady) return
    const t = this.transport

    for (const id of this.noteEventIds) t.clear(id)
    this.noteEventIds = []

    const bpb = beatsPerBarOf(project.timeSignature)

    for (const track of project.tracks) {
      const channel = this.channels.get(track.id)
      if (!channel) continue
      const drum = isDrumTrack(track.instrument)

      for (const region of track.regions) {
        for (const note of region.notes) {
          const at = beatsToTransportTime(region.start + note.start, bpb)
          const eventId = t.schedule((time: number) => {
            // 时长在触发瞬间按当前 BPM 计算，跟随变速
            const seconds = note.duration * (60 / t.bpm.value)
            if (drum) channel.node.triggerAttackRelease(note.midi, seconds, time, note.velocity)
            else channel.node.triggerAttackRelease(midiToNoteName(note.midi), seconds, time, note.velocity)
            this.onNoteOn?.(note.midi, track.id)
          }, at)
          this.noteEventIds.push(eventId)
        }
      }
    }

    // 循环区间始终覆盖整个工程长度
    t.loopStart = 0
    t.loopEnd = beatsToTransportTime(project.bars * bpb, bpb)
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
    this.transport.timeSignature = beatsPerBarOf(ts)
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

  private rebuildMetronome(): void {
    if (!this.graphReady) return
    const t = this.transport
    if (this.metronomeId !== null) {
      t.clear(this.metronomeId)
      this.metronomeId = null
    }
    if (!this.metronomeOn) return

    const bpb = beatsPerBarOf(this.timeSignature)
    // 每四分音符一次点击，重音落在小节第一拍
    this.metronomeId = t.scheduleRepeat((time: number) => {
      const ticks = t.getTicksAtTime(time)
      const beatInBar = Math.round(ticks / t.PPQ) % bpb
      this.playClick(time, beatInBar === 0)
    }, '4n', 0)
  }

  /** 播放一次节拍器点击 */
  private playClick(time: number, accent: boolean): void {
    if (!this.graphReady) return
    const synth = accent ? this.clickHi : this.clickLo
    synth.triggerAttackRelease(accent ? 'C6' : 'G5', 0.03, time, accent ? 0.95 : 0.6)
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
      const spb = 60 / this.bpm
      const bpb = beatsPerBarOf(this.timeSignature)
      const begin = Tone.now() + 0.12
      for (let i = 0; i < bpb; i += 1) {
        this.playClick(begin + i * spb, i === 0)
      }
      t.start(begin + bpb * spb)
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
    if (!channel) return
    const now = Tone.getContext().currentTime
    if (isDrumTrack(channel.instrument)) channel.node.triggerAttack(midi, now, velocity)
    else channel.node.triggerAttack(midiToNoteName(midi), now, velocity)
  }

  previewRelease(trackId: string, midi: number): void {
    const channel = this.channels.get(trackId)
    if (!channel) return
    const now = Tone.getContext().currentTime
    if (isDrumTrack(channel.instrument)) channel.node.triggerRelease(midi, now)
    else channel.node.triggerRelease(midiToNoteName(midi), now)
  }

  // ------------------------------------------------------------ 离线渲染 WAV

  /**
   * 用 Tone.Offline 离线渲染整个工程，返回 AudioBuffer。
   * 注意：Tone.Offline 执行期间全局上下文会临时切换到离线上下文，
   * 回调里拿到的 transport 属于该离线上下文，因此节点与排期都在回调内创建。
   * 这里的信号链与实时播放保持一致（均衡 → 声像 → 推子 → 干声/混响总线 → 限幅）。
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

      const nodes = new Map<string, InstrumentNode>()
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

        const node = createInstrument(track.instrument)
        node.connect(eq)
        nodes.set(track.id, node)
      }

      for (const track of project.tracks) {
        const node = nodes.get(track.id)
        if (!node) continue
        const drum = isDrumTrack(track.instrument)
        for (const region of track.regions) {
          for (const note of region.notes) {
            const at = beatsToTransportTime(region.start + note.start, bpb)
            const seconds = note.duration * secondsPerBeat
            transport.schedule((time) => {
              if (drum) node.triggerAttackRelease(note.midi, seconds, time, note.velocity)
              else node.triggerAttackRelease(midiToNoteName(note.midi), seconds, time, note.velocity)
            }, at)
          }
        }
      }

      transport.bpm.value = project.bpm
      transport.timeSignature = bpb
      transport.start(0)
    }, duration)

    const audioBuffer = rendered.get()
    if (!audioBuffer) throw new Error('离线渲染失败：未得到音频数据')
    return audioBuffer
  }
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
