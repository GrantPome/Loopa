/**
 * 波形工具
 * 采样数据只用于播放与持久化，界面展示用的是「峰值」——
 * 把整段音频按时间均匀分桶，每桶记录最小/最大值，
 * 这样 Canvas 只需要画几千个矩形就能还原波形轮廓，且工程 JSON 也不会爆掉。
 */

/** 峰值数组的长度（桶数）：越高波形越精细，但 JSON 体积也越大 */
export const PEAK_BUCKETS = 1200

/**
 * 计算降采样峰值。
 * 返回长度为 buckets * 2 的数组，依次是 [min, max, min, max, ...]，取值 -1~1。
 */
export function computePeaks(channels: Float32Array[], buckets = PEAK_BUCKETS): number[] {
  const out = new Array<number>(buckets * 2).fill(0)
  if (channels.length === 0 || buckets <= 0) return out

  const length = channels[0].length
  if (length === 0) return out

  const samplesPerBucket = Math.max(1, Math.floor(length / buckets))
  for (let b = 0; b < buckets; b += 1) {
    const from = b * samplesPerBucket
    const to = Math.min(length, from + samplesPerBucket)
    let min = 1
    let max = -1
    for (let c = 0; c < channels.length; c += 1) {
      const data = channels[c]
      for (let i = from; i < to; i += 1) {
        const v = data[i]
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (min > max) {
      min = 0
      max = 0
    }
    out[b * 2] = min
    out[b * 2 + 1] = max
  }
  return out
}

/**
 * 把峰值数组按 [from, to) 的归一化比例映射到画布宽度。
 * 峰值桶数与像素宽度通常不一致，这里按「像素 -> 桶区间」聚合，
 * 保证缩放时波形不会出现空洞。
 */
export function peakRange(
  peaks: number[],
  fromRatio: number,
  toRatio: number,
  buckets: number
): { min: number; max: number } {
  if (buckets <= 0) return { min: 0, max: 0 }
  const startBucket = Math.max(0, Math.floor(fromRatio * buckets))
  const endBucket = Math.min(buckets, Math.max(startBucket + 1, Math.ceil(toRatio * buckets)))
  let min = 1
  let max = -1
  for (let b = startBucket; b < endBucket; b += 1) {
    const lo = peaks[b * 2]
    const hi = peaks[b * 2 + 1]
    if (lo < min) min = lo
    if (hi > max) max = hi
  }
  if (min > max) return { min: 0, max: 0 }
  return { min, max }
}
