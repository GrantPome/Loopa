/**
 * 内置示例音频（示范素材）
 *
 * 纯代码合成一段 4 小节、120 BPM 的循环（与新建工程的默认速度一致，恰好对齐网格）：
 * 底鼓 / 军鼓 / 踩镲 + 贝斯 + 和弦垫 + 旋律。
 * 鼓点都落在整齐的拍点上，方便演示波形编辑、修剪与「自动卡点」；
 * 最终输出标准 16bit PCM WAV 文件，走与用户上传文件完全相同的导入流程。
 */
import { pcmChannelsToWavBlob } from '@/utils/wav'

/** 示例音频参数：4 小节 4/4 拍，120 BPM，总长 8 秒 */
const BPM = 120
/** 一拍的秒数 */
const BEAT = 60 / BPM
/** 小节数 */
const BARS = 4
/** 采样率 */
const SAMPLE_RATE = 44100
/** 总时长（秒） */
const TOTAL_SECONDS = BARS * 4 * BEAT
/** 噪声种子：固定值，保证每次生成的示例音频完全一致 */
const NOISE_SEED = 20261017
/** 四小节和声进行：Am - F - C - G（根音 + 三和弦） */
const PROGRESSION = [
  { root: 45, triad: [57, 60, 64] },
  { root: 41, triad: [53, 57, 60] },
  { root: 48, triad: [60, 64, 67] },
  { root: 43, triad: [55, 59, 62] }
]
/** 鼓组节奏（以八分音符为单位，每小节 8 格） */
const KICK_STEPS = [0, 3, 4]
const SNARE_STEPS = [2, 6]
/** 旋律（只在第 3、4 小节出现）：[八分位置, MIDI 音号, 时长（八分音符个数）] */
const MELODY: [number, number, number][] = [
  [16, 76, 2],
  [18, 74, 1],
  [19, 72, 1],
  [21, 69, 2],
  [24, 72, 1],
  [25, 74, 1],
  [26, 76, 2],
  [28, 79, 2],
  [30, 76, 2]
]

/** 混音缓冲区：左右两个声道 */
interface MixBuffer {
  left: Float32Array
  right: Float32Array
}

/** MIDI 音号 -> 频率（Hz），A4 = 69 = 440Hz */
function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** 确定性伪随机数（mulberry32）：让噪声成分每次生成都一致 */
function createRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 把一个声部的波形叠加进混音缓冲。
 * @param start 起始时间（秒）
 * @param duration 持续时长（秒）
 * @param gain 音量
 * @param pan 声像：-1 全左，0 居中，1 全右
 * @param release 结尾释放淡出时长（秒），避免硬切造成爆音
 * @param sample 波形函数：入参为相对起始点的秒数，返回 -1~1 的样本值
 */
function addVoice(
  mix: MixBuffer,
  start: number,
  duration: number,
  gain: number,
  pan: number,
  release: number,
  sample: (t: number) => number
): void {
  const startFrame = Math.floor(start * SAMPLE_RATE)
  const frames = Math.floor(duration * SAMPLE_RATE)
  // 等功率声像：保证左右声道能量之和恒定
  const angle = ((pan + 1) * Math.PI) / 4
  const gainLeft = Math.cos(angle) * gain
  const gainRight = Math.sin(angle) * gain

  for (let i = 0; i < frames; i += 1) {
    const index = startFrame + i
    if (index < 0 || index >= mix.left.length) continue
    const t = i / SAMPLE_RATE
    // 结尾释放淡出
    const fade = release > 0 ? Math.min(1, Math.max(0, (duration - t) / release)) : 1
    const value = sample(t) * fade
    mix.left[index] += value * gainLeft
    mix.right[index] += value * gainRight
  }
}

/** 底鼓：正弦波音高从 150Hz 快速下坠到 45Hz，低频冲击感明确 */
function kickSample(t: number): number {
  const from = 150
  const to = 45
  const k = 32
  // 对频率积分得到相位，避免直接用 f*t 造成音高下坠时的相位跳变
  const phase = to * t + ((from - to) * (1 - Math.exp(-k * t))) / k
  const env = Math.exp(-t * 15) * Math.min(1, t / 0.003)
  return Math.sin(2 * Math.PI * phase) * env
}

/** 军鼓：190Hz 鼓皮音 + 高通化噪声（噪声做一阶差分提亮） */
function makeSnareSample(random: () => number): (t: number) => number {
  let prev = 0
  return (t) => {
    const noise = random() * 2 - 1
    const bright = noise - prev
    prev = noise
    return 0.5 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 28) + 0.42 * bright * Math.exp(-t * 22)
  }
}

/** 踩镲：高通化噪声 + 衰减（decay 越大越「闭」） */
function makeHatSample(random: () => number, decay: number): (t: number) => number {
  let prev = 0
  return (t) => {
    const noise = random() * 2 - 1
    const bright = noise - prev
    prev = noise
    return 0.5 * bright * Math.exp(-t * decay)
  }
}

/** 贝斯：基频 + 少量谐波，起音略亮、随后转厚 */
function bassSample(freq: number): (t: number) => number {
  return (t) => {
    const w = 2 * Math.PI * freq * t
    const env = Math.min(1, t / 0.006) * (0.65 + 0.35 * Math.exp(-t * 7))
    return (Math.sin(w) + 0.26 * Math.sin(2 * w) + 0.1 * Math.sin(3 * w)) * env
  }
}

/** 和弦垫：两个轻微失谐的振荡叠加，柔和铺底 */
function padSample(freq: number): (t: number) => number {
  return (t) => {
    const w = 2 * Math.PI * freq * t
    const detune = 2 * Math.PI * freq * 1.004 * t
    return (Math.sin(w) + Math.sin(detune) + 0.3 * Math.sin(2 * w)) / 2.2
  }
}

/** 旋律音色：基频 + 奇次谐波，短促的拨弦式衰减 */
function pluckSample(freq: number): (t: number) => number {
  return (t) => {
    const w = 2 * Math.PI * freq * t
    const env = Math.min(1, t / 0.006) * Math.exp(-t * 4.2)
    return (Math.sin(w) + 0.22 * Math.sin(3 * w) + 0.08 * Math.sin(5 * w)) * env
  }
}

/** 归一化到统一响度，并做首尾淡入淡出，保证不削顶、不爆音 */
function normalize(mix: MixBuffer): void {
  let peak = 0
  for (let i = 0; i < mix.left.length; i += 1) {
    peak = Math.max(peak, Math.abs(mix.left[i]), Math.abs(mix.right[i]))
  }
  if (peak > 0) {
    const scale = 0.92 / peak
    for (let i = 0; i < mix.left.length; i += 1) {
      mix.left[i] *= scale
      mix.right[i] *= scale
    }
  }

  // 首尾各 20ms 淡入淡出
  const fadeFrames = Math.round(0.02 * SAMPLE_RATE)
  for (let i = 0; i < fadeFrames; i += 1) {
    const k = i / fadeFrames
    mix.left[i] *= k
    mix.right[i] *= k
    const tail = mix.left.length - 1 - i
    mix.left[tail] *= k
    mix.right[tail] *= k
  }
}

/** 合成示例音频，返回双声道 PCM */
export function synthesizeDemoLoop(): { channels: Float32Array[]; sampleRate: number } {
  const frames = Math.round(TOTAL_SECONDS * SAMPLE_RATE)
  const mix: MixBuffer = { left: new Float32Array(frames), right: new Float32Array(frames) }
  const random = createRandom(NOISE_SEED)
  const snare = makeSnareSample(random)
  const hatClosed = makeHatSample(random, 55)
  const hatOpen = makeHatSample(random, 7)
  const eighth = BEAT / 2

  for (let bar = 0; bar < BARS; bar += 1) {
    const barStart = bar * 4 * BEAT
    const { root, triad } = PROGRESSION[bar]

    // 每小节开头的开镲：给出明显的重音，便于演示「自动卡点」
    addVoice(mix, barStart, 0.5, 0.16, 0.15, 0.2, hatOpen)

    for (let step = 0; step < 8; step += 1) {
      const time = barStart + step * eighth
      if (KICK_STEPS.includes(step)) addVoice(mix, time, 0.35, 0.95, 0, 0.05, kickSample)
      if (SNARE_STEPS.includes(step)) addVoice(mix, time, 0.3, 0.6, 0, 0.05, snare)
      // 踩镲：正拍重、反拍轻，做出摇摆律动
      addVoice(mix, time, 0.12, step % 2 === 0 ? 0.13 : 0.07, 0.2, 0.03, hatClosed)
    }

    // 贝斯：根音落在第 1、3 拍，第 4 拍用五度做推进
    addVoice(mix, barStart, 0.42, 0.42, 0, 0.05, bassSample(midiToFreq(root)))
    addVoice(mix, barStart + 2 * BEAT, 0.42, 0.4, 0, 0.05, bassSample(midiToFreq(root)))
    addVoice(mix, barStart + 3 * BEAT, 0.6, 0.36, 0, 0.05, bassSample(midiToFreq(root + 7)))

    // 和弦垫：整小节长音，三个音左右轻微铺开
    triad.forEach((midi, index) => {
      const pan = index === 0 ? -0.35 : index === 2 ? 0.35 : 0
      addVoice(mix, barStart, 4 * BEAT, 0.16, pan, 0.25, padSample(midiToFreq(midi)))
    })
  }

  // 旋律：第 3、4 小节加入
  MELODY.forEach(([step, midi, length]) => {
    addVoice(mix, step * eighth, length * eighth, 0.34, 0.1, 0.06, pluckSample(midiToFreq(midi)))
  })

  normalize(mix)
  return { channels: [mix.left, mix.right], sampleRate: SAMPLE_RATE }
}

/** 生成可直接导入的示例音频文件（WAV） */
export function createDemoAudioFile(): File {
  const { channels, sampleRate } = synthesizeDemoLoop()
  const blob = pcmChannelsToWavBlob(channels, sampleRate)
  return new File([blob], '示例音频 鼓点循环.wav', { type: 'audio/wav' })
}
