/** errno → 语义分类。§8/§9：任何一类错误都只是「记录 + 跳过 + 继续」，不得让扫描失败。 */
export type ScanErrorKind = 'denied' | 'missing' | 'busy' | 'tooManyHandles' | 'notDir' | 'cycle' | 'unknown'

const CODE_MAP: Record<string, ScanErrorKind> = {
  EPERM: 'denied',
  EACCES: 'denied',
  ENOENT: 'missing',
  ENOTDIR: 'missing',
  EBUSY: 'busy',
  ETXTBSY: 'busy',
  EMFILE: 'tooManyHandles',
  ENFILE: 'tooManyHandles',
  ELOOP: 'cycle'
}

/** 不认识的 code / 非 Error 输入一律归 'unknown'，绝不抛。 */
export function classifyFsError(err: unknown): ScanErrorKind {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return (code && CODE_MAP[code]) || 'unknown'
}

/** 无条件跳过的目录名（小写）。回收站 $Recycle.Bin 不在此列——它要显示、要计容量，但归 🔴。 */
export const SKIP_ALWAYS: ReadonlySet<string> = new Set(['system volume information', 'dumpstack.log.tmp'])
