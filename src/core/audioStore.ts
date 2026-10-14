/**
 * 音频采样持久化（IndexedDB）
 *
 * 波形采样（Float32）体积远大于 JSON，塞进 localStorage 会迅速超出配额，
 * 因此 PCM 单独存放于 IndexedDB；工程 JSON 只保留片段元信息与降采样峰值。
 *
 * 音频排期是同步逻辑，而 IndexedDB 读取是异步的，
 * 所以这里额外维护一份内存缓存：工程加载 / 录音 / 导入音频完成后预热，
 * 之后引擎取采样就是零延迟的同步操作。
 */

const DB_NAME = 'muisc-editor-audio'
const DB_VERSION = 1
const STORE_NAME = 'pcm'

/** 一段 PCM 采样：每声道一个 Float32Array */
export interface PcmData {
  channels: Float32Array[]
  sampleRate: number
}

let dbPromise: Promise<IDBDatabase> | null = null

/** 内存缓存：key -> PCM */
const cache = new Map<string, PcmData>()

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('无法打开音频数据库'))
  })
  return dbPromise
}

/** 统一的读写封装，避免每处都手写事务样板代码 */
function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode)
        const request = action(transaction.objectStore(STORE_NAME))
        request.onsuccess = () => resolve(request.result as T)
        request.onerror = () => reject(request.error ?? new Error('音频数据库操作失败'))
      })
  )
}

/** 写入采样（同时更新内存缓存） */
export async function putPcm(key: string, data: PcmData): Promise<void> {
  cache.set(key, data)
  await run<void>('readwrite', (store) => store.put(data, key))
}

/** 读取采样（优先走缓存） */
export async function getPcm(key: string): Promise<PcmData | null> {
  const cached = cache.get(key)
  if (cached) return cached
  try {
    const raw = await run<PcmData | undefined>('readonly', (store) => store.get(key))
    if (!raw || !Array.isArray(raw.channels)) return null
    cache.set(key, raw)
    return raw
  } catch (error) {
    console.warn('[audioStore] 读取采样失败', error)
    return null
  }
}

/** 删除采样（同时清缓存） */
export async function deletePcm(key: string): Promise<void> {
  cache.delete(key)
  try {
    await run<void>('readwrite', (store) => store.delete(key))
  } catch (error) {
    console.warn('[audioStore] 删除采样失败', error)
  }
}

/** 列出数据库中的全部采样键 */
export async function listPcmKeys(): Promise<string[]> {
  try {
    const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys())
    return keys.map((k) => String(k))
  } catch {
    return []
  }
}

/** 预热：把给定键的采样读入内存缓存，返回实际加载成功的键 */
export async function preloadPcm(keys: string[]): Promise<string[]> {
  const loaded: string[] = []
  for (const key of keys) {
    if (cache.has(key)) {
      loaded.push(key)
      continue
    }
    const data = await getPcm(key)
    if (data) loaded.push(key)
  }
  return loaded
}

/** 同步读取缓存（引擎排期使用） */
export function getCachedPcm(key: string): PcmData | null {
  return cache.get(key) ?? null
}

/** 缓存中是否已有该采样 */
export function hasCachedPcm(key: string): boolean {
  return cache.has(key)
}

/** 清掉不在 keep 列表中的孤儿采样，避免数据库无限增长 */
export async function prunePcm(keep: string[]): Promise<void> {
  const keepSet = new Set(keep)
  const keys = await listPcmKeys()
  for (const key of keys) {
    if (!keepSet.has(key)) {
      cache.delete(key)
      await deletePcm(key)
    }
  }
}

/** 清空全部采样（用于彻底重置） */
export async function clearAllPcm(): Promise<void> {
  cache.clear()
  try {
    await run<void>('readwrite', (store) => store.clear())
  } catch (error) {
    console.warn('[audioStore] 清空采样失败', error)
  }
}

/** 把 AudioBuffer 拆成按声道排列的 Float32Array（拷贝，避免持有 AudioBuffer） */
export function audioBufferToPcm(buffer: AudioBuffer): PcmData {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    channels.push(new Float32Array(buffer.getChannelData(c)))
  }
  return { channels, sampleRate: buffer.sampleRate }
}

/**
 * 把 PCM 采样打包成 AudioBuffer（WebAudio 的通用数据容器）。
 * 音频片段与自定义音源采样都走这里，保证两处数据格式一致。
 */
export function pcmToAudioBuffer(pcm: PcmData): AudioBuffer {
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

/** 采样缓存键 → AudioBuffer（同步读取，供引擎排期与自定义音源构建使用） */
export function cachedPcmToAudioBuffer(key: string): AudioBuffer | null {
  const pcm = cache.get(key)
  return pcm ? pcmToAudioBuffer(pcm) : null
}
