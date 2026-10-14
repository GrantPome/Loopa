/**
 * 录音模块
 *
 * 使用浏览器原生的 MediaRecorder 采集麦克风输入，停止后解码成 PCM。
 * 之所以不直接用 Tone.Recorder：MediaRecorder 的兼容性与权限提示行为更可预期，
 * 且我们只需要「一段原始采样」，不需要实时流处理。
 *
 * 采集参数刻意关闭了回声消除 / 降噪 / 自动增益：
 * 这三项会明显改变音色与动态，对音乐录制是负面效果。
 */
import * as Tone from 'tone'
import { audioBufferToPcm, type PcmData } from './audioStore'

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let startedAt = 0
let active = false

/** 是否正在录音 */
export function isRecording(): boolean {
  return active
}

/** 已录制时长（秒） */
export function recordingSeconds(): number {
  return active ? (performance.now() - startedAt) / 1000 : 0
}

/** 请求麦克风权限并开始录音 */
export async function startRecording(): Promise<void> {
  if (active) return
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持录音（缺少 getUserMedia）')
  }

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })

  chunks = []
  const mime = pickMimeType()
  recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  }
  // 每秒切一次数据块，避免长时间录音时内存里堆积一个巨大 Blob
  recorder.start(1000)
  startedAt = performance.now()
  active = true
}

/** 停止录音并返回解码后的 PCM（未录到有效数据时返回 null） */
export async function stopRecording(): Promise<PcmData | null> {
  if (!active || !recorder) {
    releaseStream()
    return null
  }

  const blob = await new Promise<Blob>((resolve) => {
    const current = recorder
    if (!current) {
      resolve(new Blob([]))
      return
    }
    current.onstop = () => resolve(new Blob(chunks, { type: current.mimeType || 'audio/webm' }))
    current.stop()
  })

  active = false
  releaseStream()
  recorder = null
  chunks = []

  if (blob.size === 0) return null

  const raw = await blob.arrayBuffer()
  const context = Tone.getContext().rawContext as BaseAudioContext
  const audioBuffer = await context.decodeAudioData(raw.slice(0))
  return audioBufferToPcm(audioBuffer)
}

/**
 * 解码音频文件（wav / mp3 / m4a / ogg…）为 PCM。
 * 交给音频上下文解码可以复用浏览器内置的解码器，无需额外依赖。
 */
export async function decodeAudioFile(file: Blob): Promise<PcmData> {
  const raw = await file.arrayBuffer()
  const context = Tone.getContext().rawContext as BaseAudioContext
  const audioBuffer = await context.decodeAudioData(raw.slice(0))
  return audioBufferToPcm(audioBuffer)
}

/** 放弃本次录音（不产生片段） */
export function cancelRecording(): void {
  try {
    recorder?.stop()
  } catch {
    // 已停止时忽略
  }
  active = false
  recorder = null
  chunks = []
  releaseStream()
}

function releaseStream(): void {
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
}

/** 挑选浏览器支持的录音容器格式 */
function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return ''
}
