/**
 * Web MIDI 硬件输入
 * - 枚举 / 选择输入设备
 * - 解析 note on / note off 消息并转发给 store（试听 + 录制）
 * 不使用 sysEx，只处理最基础的音符消息。
 */
import { reactive } from 'vue'

export interface MidiDeviceOption {
  id: string
  name: string
}

export const midiState = reactive({
  /** 浏览器是否支持 Web MIDI */
  supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
  /** 是否已成功获取 MIDI 访问权限 */
  enabled: false,
  /** 可用的输入设备列表 */
  devices: [] as MidiDeviceOption[],
  /** 当前选中的输入设备 id（空 = 监听全部输入） */
  selectedId: '',
  /** 错误信息（权限被拒、不支持等） */
  error: ''
})

/** 本地最小结构声明：不同 TS 版本的 lib.dom 对 Web MIDI 覆盖不一致，统一走结构化类型 */
interface MinimalMidiMessage {
  data: Uint8Array
}
interface MinimalMidiInput {
  id: string
  name?: string
  onmidimessage: ((event: MinimalMidiMessage) => void) | null
}
interface MinimalMidiAccess extends EventTarget {
  inputs: Map<string, MinimalMidiInput>
}

type NoteOnHandler = (midi: number, velocity: number) => void
type NoteOffHandler = (midi: number) => void

let noteOnHandler: NoteOnHandler | null = null
let noteOffHandler: NoteOffHandler | null = null
let access: MinimalMidiAccess | null = null

/** 注册音符回调（store 在初始化时调用一次） */
export function setMidiHandlers(on: NoteOnHandler, off: NoteOffHandler): void {
  noteOnHandler = on
  noteOffHandler = off
}

/** 申请 MIDI 访问权限并枚举输入设备 */
export async function enableMidi(): Promise<void> {
  if (midiState.enabled) return
  const requester = (
    navigator as unknown as {
      requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MinimalMidiAccess>
    }
  ).requestMIDIAccess
  if (!requester) {
    midiState.error = '当前浏览器不支持 Web MIDI（可使用 Chrome / Edge）'
    return
  }
  try {
    access = await requester.call(navigator, { sysex: false })
    midiState.enabled = true
    midiState.error = ''
    refreshDevices()
    // 设备热插拔时重新枚举并绑定监听
    access.addEventListener('statechange', refreshDevices)
  } catch (error) {
    midiState.error = `无法访问 MIDI 设备：${(error as Error).message}`
  }
}

/** 断开监听并清空设备列表 */
export function disableMidi(): void {
  if (access) {
    access.inputs.forEach((input) => {
      input.onmidimessage = null
    })
  }
  access = null
  midiState.enabled = false
  midiState.devices = []
  midiState.selectedId = ''
  midiState.error = ''
}

/** 切换监听的输入设备（空 = 全部输入） */
export function selectMidiDevice(id: string): void {
  midiState.selectedId = id
  bindInputs()
}

/** 重新枚举输入设备，并按当前选择重新绑定消息监听 */
function refreshDevices(): void {
  if (!access) return
  const list: MidiDeviceOption[] = []
  access.inputs.forEach((input) => {
    list.push({ id: input.id, name: input.name || `MIDI 输入 ${list.length + 1}` })
  })
  midiState.devices = list
  bindInputs()
}

/** 把 onmidimessage 绑到应监听的输入上；设备热插拔后也需要重新绑定 */
function bindInputs(): void {
  if (!access) return
  access.inputs.forEach((input) => {
    input.onmidimessage =
      midiState.selectedId === '' || input.id === midiState.selectedId ? onMidiMessage : null
  })
}

/** 解析音符消息：0x9n 开启（力度 > 0）、0x8n / 0x9n 力度 0 结束 */
function onMidiMessage(event: MinimalMidiMessage): void {
  const data = event.data
  if (!data || data.length < 2) return
  const status = data[0]
  const note = data[1]
  const velocity = data.length > 2 ? data[2] : 0
  const command = status & 0xf0
  if (command === 0x90 && velocity > 0) {
    noteOnHandler?.(note, velocity / 127)
  } else if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    noteOffHandler?.(note)
  }
}
