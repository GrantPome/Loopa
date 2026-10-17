/**
 * AudioBuffer -> WAV(16/24bit PCM) Blob
 * 自己实现编码，避免为了导出引入额外依赖。
 */
export function audioBufferToWavBlob(buffer: AudioBuffer, bitDepth: 16 | 24 = 16): Blob {
  // 取出各声道数据（超出 2 声道时只保留前两个），其余交给通用编码函数
  const numChannels = Math.min(2, buffer.numberOfChannels)
  const channels: Float32Array[] = []
  for (let c = 0; c < numChannels; c += 1) {
    channels.push(buffer.getChannelData(c))
  }
  return pcmChannelsToWavBlob(channels, buffer.sampleRate, bitDepth)
}

/**
 * 多声道 PCM（Float32）-> WAV(16/24bit PCM) Blob
 * 供没有 AudioBuffer 的场景直接编码，例如代码实时合成的示例音频。
 */
export function pcmChannelsToWavBlob(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 16 | 24 = 16
): Blob {
  const numChannels = Math.min(2, channels.length)
  const numFrames = channels[0]?.length ?? 0

  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const headerSize = 44

  const arrayBuffer = new ArrayBuffer(headerSize + dataSize)
  const view = new DataView(arrayBuffer)

  let offset = 0
  const writeString = (str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i))
    }
    offset += str.length
  }

  // ---- RIFF 头 ----
  writeString('RIFF')
  view.setUint32(offset, 36 + dataSize, true) // 文件长度 - 8
  offset += 4
  writeString('WAVE')

  // ---- fmt 子块 ----
  writeString('fmt ')
  view.setUint32(offset, 16, true) // PCM 子块大小
  offset += 4
  view.setUint16(offset, 1, true) // 编码格式：PCM
  offset += 2
  view.setUint16(offset, numChannels, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true) // 字节率
  offset += 4
  view.setUint16(offset, blockAlign, true)
  offset += 2
  view.setUint16(offset, bitDepth, true) // 位深
  offset += 2

  // ---- data 子块 ----
  writeString('data')
  view.setUint32(offset, dataSize, true)
  offset += 4

  // 交错写入：16bit 用 setInt16，24bit 手工拆成 3 个字节（小端）
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][frame]))
      if (bitDepth === 16) {
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      } else {
        const value = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff)
        // 小端 3 字节：低 8 位、中 8 位、高 8 位（最高位是符号）
        view.setUint8(offset, value & 0xff)
        view.setUint8(offset + 1, (value >> 8) & 0xff)
        view.setUint8(offset + 2, (value >> 16) & 0xff)
      }
      offset += bytesPerSample
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 稍后释放，避免部分浏览器下载未开始就回收
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
