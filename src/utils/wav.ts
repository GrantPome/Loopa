/**
 * AudioBuffer -> WAV(16bit PCM) Blob
 * 自己实现编码，避免为了导出引入额外依赖。
 */
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels)
  const sampleRate = buffer.sampleRate
  const numFrames = buffer.length

  const bytesPerSample = 2
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
  view.setUint16(offset, 8 * bytesPerSample, true) // 位深
  offset += 2

  // ---- data 子块 ----
  writeString('data')
  view.setUint32(offset, dataSize, true)
  offset += 4

  // 取出各声道数据（超出 2 声道时只保留前两个）
  const channels: Float32Array[] = []
  for (let c = 0; c < numChannels; c += 1) {
    channels.push(buffer.getChannelData(c))
  }

  // 交错写入并转成 16bit
  for (let frame = 0; frame < numFrames; frame += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][frame]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
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
