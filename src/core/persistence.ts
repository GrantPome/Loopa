import type { Project, ProjectMeta } from '@/types'

/** localStorage 键名（带版本号，后续结构升级时方便迁移） */
const PROJECTS_KEY = 'muisc-editor:v1:projects'
const LAST_KEY = 'muisc-editor:v1:last'

/** 最多保留的历史工程数量 */
const MAX_SAVED = 12

interface StorageShape {
  version: 1
  projects: Project[]
}

/** 读取全部历史工程（容错：解析失败时返回空数组） */
export function readProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as StorageShape
    if (!parsed || !Array.isArray(parsed.projects)) return []
    return parsed.projects
  } catch (error) {
    console.warn('[persistence] 读取历史工程失败', error)
    return []
  }
}

/** 只取元信息，列表页无需加载全部音符 */
export function readMetas(): ProjectMeta[] {
  return readProjects()
    .map((p) => ({
      id: p.id,
      name: p.name,
      bpm: p.bpm,
      timeSignature: p.timeSignature,
      trackCount: p.tracks.length,
      noteCount: p.tracks.reduce(
        (sum, t) => sum + t.regions.reduce((s, r) => s + r.notes.length, 0),
        0
      ),
      updatedAt: p.updatedAt
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 保存（按 id 覆盖或新增），并按更新时间裁剪数量 */
export function saveProject(project: Project): void {
  try {
    const others = readProjects().filter((p) => p.id !== project.id)
    // JSON 序列化顺带剥掉 Vue 的响应式代理，保证存入的是纯数据
    const snapshot = JSON.parse(JSON.stringify(project)) as Project
    const list = [snapshot, ...others]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SAVED)
    const payload: StorageShape = { version: 1, projects: list }
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(payload))
    localStorage.setItem(LAST_KEY, project.id)
  } catch (error) {
    console.warn('[persistence] 保存工程失败（可能超出存储配额）', error)
  }
}

/** 按 id 读取完整工程 */
export function loadProject(id: string): Project | null {
  return readProjects().find((p) => p.id === id) ?? null
}

/** 删除某个历史工程 */
export function deleteProject(id: string): void {
  try {
    const list = readProjects().filter((p) => p.id !== id)
    const payload: StorageShape = { version: 1, projects: list }
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(payload))
    if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY)
  } catch (error) {
    console.warn('[persistence] 删除工程失败', error)
  }
}

/** 上次打开的工程 id */
export function readLastProjectId(): string {
  return localStorage.getItem(LAST_KEY) ?? ''
}

export function writeLastProjectId(id: string): void {
  localStorage.setItem(LAST_KEY, id)
}
