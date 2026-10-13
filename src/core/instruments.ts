import * as Tone from 'tone'
import type { InstrumentType, MelodicInstrumentType } from '@/types'
import { midiToNoteName } from '@/utils/music'

/**
 * 乐器节点统一接口：
 * 旋律乐器接收音名（如 "C4"），鼓组接收 MIDI 音号。
 */
export interface InstrumentNode {
  connect(dest: Tone.ToneAudioNode): void
  triggerAttack(note: string | number, time?: number, velocity?: number): void
  triggerRelease(note: string | number, time?: number): void
  triggerAttackRelease(note: string | number, duration: number, time?: number, velocity?: number): void
  dispose(): void
}

/**
 * PolySynth 的泛型会随 voice 变化（Synth / FMSynth / MonoSynth 互不兼容），
 * 这里统一用 any 抹平，避免在每个调用点做类型体操。
 */
type AnyPolySynth = Tone.PolySynth<any>

/** 旋律乐器：统一用 PolySynth 包装，保证能弹和弦 */
class MelodicInstrument implements InstrumentNode {
  private synth: AnyPolySynth

  constructor(type: MelodicInstrumentType) {
    this.synth = createPolySynth(type)
    // 复音数上限，防止大量音符同时触发时爆音
    this.synth.maxPolyphony = 24
  }

  connect(dest: Tone.ToneAudioNode): void {
    this.synth.connect(dest)
  }

  triggerAttack(note: string | number, time?: number, velocity?: number): void {
    this.synth.triggerAttack(String(note), time, velocity ?? 0.8)
  }

  triggerRelease(note: string | number, time?: number): void {
    this.synth.triggerRelease(String(note), time)
  }

  triggerAttackRelease(note: string | number, duration: number, time?: number, velocity?: number): void {
    this.synth.triggerAttackRelease(String(note), duration, time, velocity ?? 0.8)
  }

  dispose(): void {
    this.synth.dispose()
  }
}

/**
 * 各音色的合成器预设（无需采样文件，纯合成器实现）。
 * 每个预设都用 volume 做了增益平衡，避免切换音色时响度突变。
 */
function createPolySynth(type: MelodicInstrumentType): AnyPolySynth {
  switch (type) {
    case 'piano': {
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle8' },
        envelope: { attack: 0.004, decay: 0.45, sustain: 0.1, release: 1.1 }
      })
      synth.volume.value = -8
      return synth
    }

    case 'electricPiano': {
      const synth = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 3.01,
        modulationIndex: 12,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.005, decay: 0.7, sustain: 0.2, release: 1.3 },
        modulation: { type: 'sine' },
        modulationEnvelope: { attack: 0.01, decay: 0.4, sustain: 0.05, release: 0.3 }
      })
      synth.volume.value = -10
      return synth
    }

    case 'organ': {
      // 风琴：方波叠加谐波 + 长延音，模拟拉杆风琴的持续音色
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'square8' },
        envelope: { attack: 0.008, decay: 0.12, sustain: 0.85, release: 0.35 }
      })
      synth.volume.value = -18
      return synth
    }

    case 'guitar': {
      // 吉他：锯齿波 + 快速衰减的滤波包络，模拟拨弦的「弹拨感」
      const synth = new Tone.PolySynth(Tone.MonoSynth, {
        oscillator: { type: 'sawtooth' },
        filter: { Q: 3, type: 'lowpass', rolloff: -12 },
        envelope: { attack: 0.005, decay: 0.35, sustain: 0.05, release: 0.4 },
        filterEnvelope: {
          attack: 0.002,
          decay: 0.25,
          sustain: 0.05,
          release: 0.3,
          baseFrequency: 220,
          octaves: 3.2
        }
      })
      synth.volume.value = -12
      return synth
    }

    case 'bass': {
      const synth = new Tone.PolySynth(Tone.MonoSynth, {
        oscillator: { type: 'sawtooth' },
        filter: { Q: 2, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.01, decay: 0.25, sustain: 0.6, release: 0.5 },
        filterEnvelope: {
          attack: 0.01,
          decay: 0.25,
          sustain: 0.3,
          release: 0.4,
          baseFrequency: 110,
          octaves: 2.2
        }
      })
      synth.volume.value = -6
      return synth
    }

    case 'strings': {
      // fatsawtooth = 多层锯齿波叠加，模拟弦乐群奏的厚度
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 22 },
        envelope: { attack: 0.26, decay: 0.4, sustain: 0.72, release: 1.1 }
      })
      synth.volume.value = -14
      return synth
    }

    case 'brass': {
      // 铜管：锯齿波 + 中等起音，强调中高频的金属感
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.05, decay: 0.2, sustain: 0.7, release: 0.3 }
      })
      synth.volume.value = -14
      return synth
    }

    case 'flute': {
      // 长笛：纯净正弦 + 慢起音，几乎没有谐波
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: 0.08, decay: 0.15, sustain: 0.85, release: 0.25 }
      })
      synth.volume.value = -10
      return synth
    }

    case 'bell': {
      // 铃铛：高调制指数的 FM，产生非谐波泛音，尾音悠长
      const synth = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 5.1,
        modulationIndex: 14,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.6, sustain: 0, release: 1.6 },
        modulation: { type: 'sine' },
        modulationEnvelope: { attack: 0.002, decay: 0.6, sustain: 0, release: 0.4 }
      })
      synth.volume.value = -14
      return synth
    }

    case 'pad': {
      // 氛围铺底：多层正弦 + 极慢起音与超长释放，用于铺满背景
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsine', count: 3, spread: 30 },
        envelope: { attack: 0.6, decay: 0.8, sustain: 0.8, release: 2.2 }
      })
      synth.volume.value = -16
      return synth
    }

    case 'synthLead':
    default: {
      // 合成主音：多层锯齿 + 高 Q 低通滤波，突出的旋律线条
      const synth = new Tone.PolySynth(Tone.MonoSynth, {
        oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
        filter: { Q: 4, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 0.3 },
        filterEnvelope: {
          attack: 0.01,
          decay: 0.15,
          sustain: 0.4,
          release: 0.2,
          baseFrequency: 300,
          octaves: 3
        }
      })
      synth.volume.value = -12
      return synth
    }
  }
}

/** 鼓组风格：原声 / 电子，仅合成参数不同，MIDI 映射完全一致 */
export type DrumStyle = 'acoustic' | 'electronic'

/**
 * 鼓组：GM 标准 MIDI 映射（简化版）
 * 35/36 底鼓、38/40 军鼓、42/44 闭合踩镲、46 开镲、41~50 通鼓、49/57 吊镲、51/59 叮叮镲
 */
class DrumKit implements InstrumentNode {
  readonly output: Tone.Gain
  private kick: Tone.MembraneSynth
  private snare: Tone.NoiseSynth
  private snareBody: Tone.Synth
  private hat: Tone.MetalSynth
  private openHat: Tone.MetalSynth
  private ride: Tone.MetalSynth
  private tom: Tone.MembraneSynth
  private crash: Tone.MetalSynth
  /** 军鼓体的音高（原声偏低、电子偏高） */
  private snareBodyNote: string

  constructor(style: DrumStyle = 'acoustic') {
    const electronic = style === 'electronic'
    this.output = new Tone.Gain(1)
    this.snareBodyNote = electronic ? 'A3' : 'D3'

    // 底鼓：电子鼓音高下落更快、尾巴更短，听感更「紧」
    this.kick = new Tone.MembraneSynth({
      pitchDecay: electronic ? 0.02 : 0.04,
      octaves: electronic ? 8 : 6,
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.001,
        decay: electronic ? 0.26 : 0.36,
        sustain: 0,
        release: electronic ? 0.08 : 0.12
      }
    })
    this.kick.volume.value = electronic ? -1 : -2

    // 军鼓 = 白噪声 + 一点音高体，避免听起来像纯噪声
    this.snare = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: electronic ? 0.09 : 0.16, sustain: 0 }
    })
    this.snare.volume.value = electronic ? -6 : -8

    this.snareBody = new Tone.Synth({
      oscillator: { type: 'triangle' },
      envelope: {
        attack: 0.001,
        decay: electronic ? 0.06 : 0.1,
        sustain: 0,
        release: 0.05
      }
    })
    this.snareBody.volume.value = -14

    this.hat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: electronic ? 0.025 : 0.045, release: 0.01 },
      harmonicity: electronic ? 6.5 : 5.1,
      modulationIndex: electronic ? 40 : 32,
      resonance: electronic ? 6000 : 4200,
      octaves: 1.5
    })
    this.hat.volume.value = -20

    this.openHat = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: electronic ? 0.2 : 0.36, release: 0.05 },
      harmonicity: electronic ? 6.5 : 5.1,
      modulationIndex: electronic ? 40 : 32,
      resonance: electronic ? 6000 : 4200,
      octaves: 1.5
    })
    this.openHat.volume.value = -22

    this.ride = new Tone.MetalSynth({
      envelope: { attack: 0.001, decay: electronic ? 0.35 : 0.6, release: 0.1 },
      harmonicity: electronic ? 4.2 : 3.1,
      modulationIndex: 24,
      resonance: electronic ? 5000 : 3200,
      octaves: 2
    })
    this.ride.volume.value = -24

    this.tom = new Tone.MembraneSynth({
      pitchDecay: electronic ? 0.05 : 0.08,
      octaves: electronic ? 5 : 4,
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.001,
        decay: electronic ? 0.2 : 0.3,
        sustain: 0,
        release: 0.1
      }
    })
    this.tom.volume.value = -8

    this.crash = new Tone.MetalSynth({
      envelope: { attack: 0.002, decay: electronic ? 0.7 : 1.1, release: 0.4 },
      harmonicity: electronic ? 3.2 : 2.4,
      modulationIndex: 40,
      resonance: electronic ? 4000 : 2600,
      octaves: electronic ? 2.5 : 3
    })
    this.crash.volume.value = -22

    const nodes: Tone.ToneAudioNode[] = [
      this.kick,
      this.snare,
      this.snareBody,
      this.hat,
      this.openHat,
      this.ride,
      this.tom,
      this.crash
    ]
    nodes.forEach((node) => node.connect(this.output))
  }

  connect(dest: Tone.ToneAudioNode): void {
    this.output.connect(dest)
  }

  triggerAttack(note: string | number, time?: number, velocity?: number): void {
    // 鼓组是单次触发乐器，直接等价于一次短促的 attackRelease
    this.triggerAttackRelease(note, 0.1, time, velocity)
  }

  triggerRelease(): void {
    // 鼓组无需 release
  }

  triggerAttackRelease(note: string | number, _duration: number, time?: number, velocity?: number): void {
    const midi = typeof note === 'number' ? note : Tone.Frequency(note).toMidi()
    const vel = velocity ?? 0.85
    const hit = time ?? Tone.now()

    switch (midi) {
      case 35:
      case 36:
        this.kick.triggerAttackRelease('C1', '8n', hit, vel)
        break
      case 38:
      case 40:
      case 39:
        this.snare.triggerAttackRelease('16n', hit, vel)
        this.snareBody.triggerAttackRelease(this.snareBodyNote, '16n', hit, vel * 0.5)
        break
      case 42:
      case 44:
        // MetalSynth 继承 Monophonic 的 triggerAttackRelease(note, duration, ...)，
        // 第一个参数是音名（实际音高由 frequency 参数决定，这里传值不影响听感）
        this.hat.triggerAttackRelease('C6', '32n', hit, vel)
        break
      case 46:
        this.openHat.triggerAttackRelease('C6', '8n', hit, vel)
        break
      case 41:
      case 43:
      case 45:
      case 47:
      case 48:
      case 50:
        this.tom.triggerAttackRelease(midiToNoteName(midi), '16n', hit, vel)
        break
      case 49:
      case 57:
        this.crash.triggerAttackRelease('C5', '2n', hit, vel)
        break
      case 51:
      case 59:
        this.ride.triggerAttackRelease('C6', '4n', hit, vel)
        break
      default:
        // 未映射的音号统一用踩镲兜底，保证不会「点了没声音」
        this.hat.triggerAttackRelease('C6', '32n', hit, vel)
    }
  }

  dispose(): void {
    this.output.dispose()
    this.kick.dispose()
    this.snare.dispose()
    this.snareBody.dispose()
    this.hat.dispose()
    this.openHat.dispose()
    this.ride.dispose()
    this.tom.dispose()
    this.crash.dispose()
  }
}

/** 工厂：按音色类型创建乐器节点（可在离线渲染上下文中复用） */
export function createInstrument(type: InstrumentType): InstrumentNode {
  if (type === 'drums') return new DrumKit('acoustic')
  if (type === 'electroDrums') return new DrumKit('electronic')
  return new MelodicInstrument(type)
}

/** 判断是否为鼓组（鼓组用 MIDI 音号，旋律用音名） */
export function isDrumTrack(type: InstrumentType): boolean {
  return type === 'drums' || type === 'electroDrums'
}
