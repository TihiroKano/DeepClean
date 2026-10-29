import { describe, expect, it } from 'vitest'
import { classifyFsError } from '../../core/fs/errors'
import { errnoOfWin32, win32Error } from '../../core/fs/winerr'

describe('win32 码 → errno 映射（裁定 4：跳过清单按码落桶的判据）', () => {
  it.each([
    [2, 'ENOENT', 'missing'],
    [3, 'ENOENT', 'missing'],
    [5, 'EACCES', 'denied'],
    [4, 'EMFILE', 'tooManyHandles'],
    [32, 'EBUSY', 'busy'],
    [33, 'EBUSY', 'busy'],
    [267, 'ENOTDIR', 'missing']
  ] as const)('win32 %i → %s → ScanErrorKind %s', (code, errno, kind) => {
    expect(errnoOfWin32(code)).toBe(errno)
    expect(classifyFsError(win32Error(code, 'C:\\x'))).toBe(kind)
  })

  it('未登记的码 → EUNKNOWN → unknown；原始码留在 .win32 上，证据不许丢', () => {
    const e = win32Error(1920, 'C:\\x')
    expect(e.code).toBe('EUNKNOWN')
    expect(classifyFsError(e)).toBe('unknown')
    expect((e as { win32?: number }).win32).toBe(1920)
    expect(e.message).toContain('1920')
    expect(e.message).toContain('C:\\x')
  })
})
