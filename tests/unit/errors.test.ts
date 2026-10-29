import { describe, expect, it } from 'vitest'
import { classifyFsError } from '../../core/fs/errors'

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

describe('classifyFsError', () => {
  it.each([
    ['EPERM', 'denied'], ['EACCES', 'denied'],
    ['ENOENT', 'missing'], ['ENOTDIR', 'missing'],
    ['EBUSY', 'busy'], ['EPERM', 'denied'],
    ['EMFILE', 'tooManyHandles'], ['ENFILE', 'tooManyHandles'],
    ['ESOMETHINGNEW', 'unknown']
  ] as const)('%s -> %s', (code, kind) => {
    expect(classifyFsError(err(code))).toBe(kind)
  })
  it('非 Error 输入不抛', () => {
    expect(classifyFsError('boom')).toBe('unknown')
    expect(classifyFsError(undefined)).toBe('unknown')
  })
})

import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeFs } from '../../core/fs/fslike'
import { attrState } from '../../shared/classify'

describe('nodeFs', () => {
  it('读真实目录，分类正确，软链接类型不算 dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-fslike-'))
    await writeFile(join(dir, 'a.txt'), 'hello')
    const ents = await nodeFs.readdir(dir)
    expect(ents.find((e) => e.name === 'a.txt')?.kind).toBe('file')
    const st = await nodeFs.stat(join(dir, 'a.txt'))
    expect(st.size).toBe(5)
  })
  it('stat 顺带把属性位读出来：同一次调用，不多花一次 I/O（§4.1）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-attrs-'))
    const f = join(dir, 'a.txt')
    await writeFile(f, 'hello')
    const before = await nodeFs.stat(f)
    expect(typeof before.attrs).toBe('number')
    // 关键陷阱（本机实测）：普通可写文件的 st_mode = 0o100666，bit 2/4/32 是**POSIX 权限位**，
    // 不是 FILE_ATTRIBUTE 的 HIDDEN/SYSTEM/ARCHIVE。照抄「mode & 2」会把整台机器上的可写文件
    // 全报成隐藏文件（C:\Users 实测：PowerShell 报 587 个隐藏文件，按位读 mode 会报 16 万+）。
    expect(attrState(before.attrs, 'hidden')).toBe('unknown')
    expect(attrState(before.attrs, 'system')).toBe('unknown')
    expect(attrState(before.attrs, 'archive')).toBe('unknown')
    expect(attrState(before.attrs, 'readonly')).toBe('clear')
    await chmod(f, 0o444)
    const after = await nodeFs.stat(f)
    expect(after.size).toBe(5)
    expect(attrState(after.attrs, 'readonly')).toBe('set')
  })
  it('不存在的路径抛 ENOENT 且被分类为 missing', async () => {
    await expect(nodeFs.readdir('C:\\__definitely_not_here__')).rejects.toBeDefined()
    try { await nodeFs.readdir('C:\\__definitely_not_here__') } catch (e) { expect(classifyFsError(e)).toBe('missing') }
  })
})
