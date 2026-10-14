/**
 * Standard MIDI File（SMF）读写
 *
 * 自己实现，不引入第三方依赖：
 * - 导出：把工程的 MIDI 轨写成 Format 1 的 .mid（速度轨 + 每轨一个 MTrk）
 * - 导入：解析 Format 0/1，还原为音符与音色
 *
 * 时间基准：内部 1 拍 = 四分音符，导出使用 PPQ=480 的 ticks 表示。
 */
import type { InstrumentType, Note, Project, TimeSignature } from '@/types'
import { clamp, uid } from '@/utils/music'

/** 导出使用的每四分音符 tick 数 */
const EXPORT_PPQ = 480

/** 音色 → GM 音色号（用于导出 Program Change） */
const GM_PROGRAM: Record<InstrumentType, number> = {
  piano: 0,
  electricPiano: 4,
  organ: 16,
  guitar: 24,
  bass: 32,
  strings: 48,
  brass: 61,
  flute: 73,
  bell: 14,
  pad: 89,
  synthLead: 80,
  drums: 0,
  electroDrums: 0
}

/** GM 音色号 → 内置音色（按音色族粗略归并） */
function programToInstrument(program: number, isDrumChannel: boolean): InstrumentType {
  if (isDrumChannel) return 'drums'
  if (program <= 7) return 'piano'
  if (program <= 15) return 'bell'
  if (program <= 23) return 'organ'
  if (program <= 31) return 'guitar'
  if (program <= 39) return 'bass'
  if (program <= 55) return 'strings'
  if (program <= 63) return 'brass'
  if (program <= 79) return 'flute'
  if (program <= 87) return 'synthLead'
  if (program <= 95) return 'pad'
  return 'piano'
}

const SUPPORTED_TS: TimeSignature[] = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8']

function isDrumInstrument(instrument: InstrumentType): boolean {
  return instrument === 'drums' || instrument === 'electroDrums'
}

// ---------------------------------------------------------------- 导出

/** 可变长度数量（VLQ）编码 */
function varLen(value: number): number[] {
  const bytes = [value & 0x7f]
  let v = value >>> 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>>= 7
  }
  return bytes
}

/** 文本 → UTF-8 字节数组 */
function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

/** 长度前缀（VLQ）+ 内容，用于 meta 事件 */
function lenPrefixed(bytes: number[]): number[] {
  return [...varLen(bytes.length), ...bytes]
}

interface RawEvent {
  tick: number
  data: number[]
}

/** 把带绝对 tick 的事件列表编码成 MTrk 数据段（内部换算成 delta 时间） */
function encodeEvents(events: RawEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick)
  const out: number[] = []
  let last = 0
  for (const event of sorted) {
    const delta = Math.max(0, event.tick - last)
    out.push(...varLen(delta), ...event.data)
    last = event.tick
  }
  return out
}

/** 组装一个 chunk（4 字节标识 + 4 字节长度 + 数据） */
function makeChunk(id: string, data: number[]): number[] {
  const out: number[] = [id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3)]
  const len = data.length
  out.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff)
  out.push(...data)
  return out
}

/**
 * 把工程导出为 MIDI 文件 Blob。
 * 音频轨不参与导出（MIDI 无法承载波形），只导出 MIDI 轨。
 */
export function projectToMidi(project: Project): Blob {
  const [num, den] = project.timeSignature.split('/').map(Number)
  const denPow = Math.round(Math.log2(den || 4))
  const usPerQuarter = Math.round(60000000 / clamp(project.bpm, 40, 200))

  // 轨道 0：速度、拍号与工程名
  const metaEvents: RawEvent[] = [
    { tick: 0, data: [0xff, 0x03, ...lenPrefixed(utf8(project.name || 'Muisc Project'))] },
    {
      tick: 0,
      data: [
        0xff, 0x51, 0x03,
        (usPerQuarter >>> 16) & 0xff, (usPerQuarter >>> 8) & 0xff, usPerQuarter & 0xff
      ]
    },
    { tick: 0, data: [0xff, 0x58, 0x04, num, denPow, 24, 8] }
  ]
  metaEvents.push({ tick: 0, data: [0xff, 0x2f, 0x00] })

  const chunks: number[] = [...makeChunk('MTrk', encodeEvents(metaEvents))]
  let trackCount = 1

  for (const track of project.tracks) {
    if (track.kind === 'audio') continue
    const drum = isDrumInstrument(track.instrument)
    const channel = drum ? 9 : 0
    const events: RawEvent[] = [{ tick: 0, data: [0xff, 0x03, ...lenPrefixed(utf8(track.name))] }]

    if (!drum) {
      events.push({ tick: 0, data: [0xc0 | channel, GM_PROGRAM[track.instrument] ?? 0] })
    }

    let maxTick = 0
    for (const region of track.regions) {
      for (const note of region.notes) {
        const startTick = Math.round((region.start + note.start) * EXPORT_PPQ)
        const endTick = startTick + Math.max(1, Math.round(note.duration * EXPORT_PPQ))
        const midi = clamp(Math.round(note.midi), 0, 127)
        const velocity = clamp(Math.round(note.velocity * 127), 1, 127)
        events.push({ tick: startTick, data: [0x90 | channel, midi, velocity] })
        events.push({ tick: endTick, data: [0x80 | channel, midi, 0] })
        maxTick = Math.max(maxTick, endTick)
      }
    }
    events.push({ tick: maxTick, data: [0xff, 0x2f, 0x00] })

    chunks.push(...makeChunk('MTrk', encodeEvents(events)))
    trackCount += 1
  }

  const header = makeChunk('MThd', [
    0x00, 0x01,
    (trackCount >>> 8) & 0xff, trackCount & 0xff,
    (EXPORT_PPQ >>> 8) & 0xff, EXPORT_PPQ & 0xff
  ])

  return new Blob([new Uint8Array([...header, ...chunks])], { type: 'audio/midi' })
}

// ---------------------------------------------------------------- 导入

export interface MidiImportedTrack {
  name: string
  instrument: InstrumentType
  notes: Note[]
}

export interface MidiImportResult {
  bpm: number
  timeSignature: TimeSignature
  tracks: MidiImportedTrack[]
}

/** 解析 MIDI 文件，还原速度、拍号与各轨音符 */
export function parseMidi(buffer: ArrayBuffer): MidiImportResult {
  const view = new DataView(buffer)
  let pos = 0

  const readU8 = (): number => view.getUint8(pos++)
  const readU16 = (): number => {
    const v = view.getUint16(pos)
    pos += 2
    return v
  }
  const readU32 = (): number => {
    const v = view.getUint32(pos)
    pos += 4
    return v
  }
  const readAscii = (n: number): string => {
    let s = ''
    for (let i = 0; i < n; i += 1) s += String.fromCharCode(readU8())
    return s
  }
  /** 读取 VLQ */
  const readVarLen = (): number => {
    let value = 0
    for (let i = 0; i < 4; i += 1) {
      const byte = readU8()
      value = (value << 7) | (byte & 0x7f)
      if ((byte & 0x80) === 0) break
    }
    return value
  }

  if (readAscii(4) !== 'MThd') throw new Error('不是有效的 MIDI 文件')
  const headerLen = readU32()
  readU16() // format
  const ntrks = readU16()
  const division = readU16()
  // 跳过可能存在的扩展头内容
  pos += Math.max(0, headerLen - 6)

  const ppq = division > 0 ? division : EXPORT_PPQ

  let bpm = 120
  let timeSignature: TimeSignature = '4/4'
  const tracks: MidiImportedTrack[] = []

  for (let t = 0; t < ntrks && pos < buffer.byteLength; t += 1) {
    if (readAscii(4) !== 'MTrk') break
    const trackLen = readU32()
    const trackEnd = pos + trackLen

    let name = ''
    let program: number | null = null
    let channel = 0
    let runningStatus = 0
    let tick = 0
    /** 待配对的 note-on：key = `${channel}:${midi}` */
    const pending = new Map<string, { tick: number; velocity: number }[]>()
    const notes: Note[] = []

    while (pos < trackEnd) {
      tick += readVarLen()
      let status = view.getUint8(pos)
      if (status & 0x80) {
        pos += 1
        runningStatus = status
      } else {
        // 运行状态：沿用上一个 status
        status = runningStatus
      }

      if (status === 0xff) {
        const metaType = readU8()
        const len = readVarLen()
        if (metaType === 0x03) {
          const bytes = new Uint8Array(buffer, pos, len)
          name = new TextDecoder().decode(bytes)
        } else if (metaType === 0x51 && len >= 3) {
          const us = (view.getUint8(pos) << 16) | (view.getUint8(pos + 1) << 8) | view.getUint8(pos + 2)
          if (us > 0) bpm = Math.round(60000000 / us)
        } else if (metaType === 0x58 && len >= 2) {
          const n = view.getUint8(pos)
          const dPow = view.getUint8(pos + 1)
          const den = Math.pow(2, dPow)
          const candidate = `${n}/${den}` as TimeSignature
          if (SUPPORTED_TS.includes(candidate)) timeSignature = candidate
        }
        pos += len
        continue
      }

      if (status === 0xf0 || status === 0xf7) {
        // SysEx：跳过
        const len = readVarLen()
        pos += len
        continue
      }

      const type = status & 0xf0
      const ch = status & 0x0f
      if (type === 0x90 || type === 0x80) {
        const midi = readU8()
        const velocity = readU8()
        channel = ch
        const key = `${ch}:${midi}`
        if (type === 0x90 && velocity > 0) {
          const list = pending.get(key) ?? []
          list.push({ tick, velocity })
          pending.set(key, list)
        } else {
          const list = pending.get(key)
          const start = list?.shift()
          if (start) {
            notes.push({
              id: uid('note'),
              midi,
              start: start.tick / ppq,
              duration: Math.max(1 / ppq, (tick - start.tick) / ppq),
              velocity: clamp(start.velocity / 127, 0.01, 1)
            })
          }
        }
      } else if (type === 0xc0) {
        program = readU8()
        channel = ch
      } else if (type === 0xd0) {
        readU8()
      } else {
        // 其余两字节消息（控制器、弯音等）：跳过数据字节
        pos += 2
      }
    }

    pos = trackEnd
    if (notes.length > 0) {
      tracks.push({
        name: name || `MIDI 轨 ${tracks.length + 1}`,
        instrument: programToInstrument(program ?? 0, channel === 9),
        notes
      })
    }
  }

  return {
    bpm: clamp(bpm, 40, 200),
    timeSignature,
    tracks
  }
}
