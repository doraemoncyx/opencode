export type PathKey = string & { _brand: "PathKey" }

const isDrive = (value: string) => {
  if (value.length !== 2) return false
  const code = value.charCodeAt(0)
  return value[1] === ":" && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
}

const trimTrailingSlashes = (value: string) => {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== "/") return value.slice(0, i + 1)
  }
  return ""
}

const isWindowsPath = (value: string) => value[1] === ":" || value.startsWith("\\\\")

export const pathKey = (path: string) => {
  const value = isWindowsPath(path) ? path.replaceAll("\\", "/") : path
  // 归一化 Windows 盘符大小写，与服务端 FSUtil.resolve 的规范保持一致，
  // 避免 f:\ 与 F:\ 因盘符大小写不同导致会话/项目路径匹配失败。
  const normalized = value.replace(/^[a-zA-Z](?=:)/, (drive) => drive.toUpperCase())
  const trimmed = trimTrailingSlashes(normalized)
  if (!trimmed && normalized.startsWith("/")) return "/" as PathKey
  if (isDrive(trimmed)) return `${trimmed}/` as PathKey
  return trimmed as PathKey
}
