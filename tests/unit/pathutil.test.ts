import { describe, expect, it } from 'vitest'
import { baseName, extOf, joinWin, normalizeKey, parentOf, toFsPath } from '../../core/fs/pathutil'

describe('joinWin', () => {
  it('根目录只有一个反斜杠', () => {
    expect(joinWin('C:\\', 'Users')).toBe('C:\\Users')
  })
  it('普通目录追加', () => {
    expect(joinWin('C:\\Users', 'Kano')).toBe('C:\\Users\\Kano')
  })
  it('末尾多余斜杠不产生双分隔符', () => {
    expect(joinWin('C:\\Users\\', 'Kano')).toBe('C:\\Users\\Kano')
  })
})

describe('normalizeKey', () => {
  it('大小写与尾斜杠归一', () => {
    expect(normalizeKey('c:\\USERS\\kano\\')).toBe('c:\\users\\kano')
    expect(normalizeKey('C:\\')).toBe('c:\\')
  })
  it('两个不同写法互为同一个 key', () => {
    expect(normalizeKey('C:\\Windows')).toBe(normalizeKey('c:\\windows'))
  })
})

describe('toFsPath', () => {
  it('短路径原样返回', () => {
    expect(toFsPath('C:\\Windows')).toBe('C:\\Windows')
  })
  it('超过 250 字符加 \\\\?\\ 前缀', () => {
    const long = 'C:\\' + 'a'.repeat(300)
    expect(toFsPath(long)).toBe('\\\\?\\' + long)
  })
  it('已有前缀不重复添加（幂等）', () => {
    const long = '\\\\?\\C:\\' + 'a'.repeat(300)
    expect(toFsPath(long)).toBe(long)
  })
  it('UNC 走 \\\\?\\unc\\', () => {
    const long = '\\\\srv\\share\\' + 'b'.repeat(300)
    expect(toFsPath(long)).toBe('\\\\?\\unc\\' + long.slice(2).replace('\\', '/'))
  })
})

describe('baseName/extOf/parentOf', () => {
  it('文件三件套', () => {
    expect(baseName('C:\\a\\b.tar.gz')).toBe('b.tar.gz')
    expect(extOf('C:\\a\\b.tar.gz')).toBe('.gz')
    expect(parentOf('C:\\a\\b.txt')).toBe('C:\\a')
    expect(parentOf('C:\\')).toBeNull()
  })
  it('盘符根的下一层，父级必须保留尾斜杠（TreeStore 靠它把 C:\\x 挂到 root 上）', () => {
    expect(parentOf('C:\\live')).toBe('C:\\')
    expect(parentOf('D:\\a\\b')).toBe('D:\\a')
    expect(parentOf('C:\\a\\')).toBe('C:\\')
  })
})
