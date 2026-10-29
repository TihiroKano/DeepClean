/**
 * Win32 错误码 → Node 风格 errno 串。
 *
 * 来由：助手（`resources/scanen.exe`）枚举失败时报的是原始 `GetLastError()` 码，
 * 而扫描器全链路（`classifyFsError` / SkipPanel 四类桶）认的是 errno 串。
 * 映射表只此一份、纯函数、可单测 —— 这就是"那 106 项跳过按码分类"的落点：
 * 助手把码带上来，这里翻译成既有语义，原始码同时留在 error 对象与日志里。
 *
 * 只登记**实测过含义**的码；其余一律 'EUNKNOWN' → ScanErrorKind 'unknown'。
 * 1920（ERROR_CANT_ACCESS_FILE）故意不映射成 denied —— 它是重解析/驱动级拒绝，
 * 语义与 ACL 拒绝不同，宁可先进 unknown 等真机数据说话。
 */
const WIN32_TO_ERRNO: Readonly<Record<number, string>> = {
  2: 'ENOENT', // FILE_NOT_FOUND
  3: 'ENOENT', // PATH_NOT_FOUND
  5: 'EACCES', // ACCESS_DENIED
  4: 'EMFILE', // TOO_MANY_OPEN_FILES
  32: 'EBUSY', // SHARING_VIOLATION
  33: 'EBUSY', // LOCK_VIOLATION
  267: 'ENOTDIR' // DIRECTORY（目标不是目录；errno→'missing' 是仓库既有约定，notDir 桶今天不可达）
}

export function errnoOfWin32(code: number): string {
  return WIN32_TO_ERRNO[code] ?? 'EUNKNOWN'
}

/** 造一个带 `code`（errno 串）与 `win32`（原始码）的错误；消息里两个证据都带上。 */
export function win32Error(code: number, path: string): NodeJS.ErrnoException {
  const e = new Error(`win32 ${code} at ${path}`) as NodeJS.ErrnoException
  e.code = errnoOfWin32(code)
  ;(e as { win32?: number }).win32 = code
  return e
}
