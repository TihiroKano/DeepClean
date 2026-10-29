import { describe, expect, it } from 'vitest'
import { classifyPath, RISK_BY_GROUP } from '../../shared/classify'

describe('classifyPath（§13 类型区分）', () => {
  it.each([
    ['C:\\Windows\\System32\\kernel32.dll', 'system'],
    ['C:\\Windows\\WinSxS\\amd64_microsoft', 'system'],
    ['C:\\Program Files\\Common Files\\svc.exe', 'app'],
    ['C:\\Program Files (x86)\\App\\app.dll', 'app'],
    ['C:\\ProgramData\\PackageCache', 'app'],
    ['C:\\Users\\Kano\\Documents\\报告.docx', 'document'],
    ['C:\\Users\\Kano\\Downloads\\a.zip', 'archive'],
    ['C:\\Users\\Kano\\AppData\\Local\\Temp\\x.tmp', 'temp'],
    ['C:\\Windows\\Temp', 'temp'],
    ['C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache', 'cache'],
    ['C:\\Users\\Kano\\AppData\\Local\\D3DSCache', 'cache'],
    ['C:\\Users\\Kano\\Videos\\clip.mp4', 'video'],
    ['C:\\Users\\Kano\\Pictures\\shot.png', 'image'],
    ['C:\\Users\\Kano\\Music\\song.flac', 'audio'],
    ['C:\\Users\\Kano\\node_modules\\react\\index.js', 'dev'],
    ['C:\\Users\\Kano\\.gradle\\caches\\modules-2', 'dev'],
    ['C:\\Users\\Kano\\AppData\\Local\\pip\\Cache', 'dev'],
    ['C:\\Models\\llama-8b.safetensors', 'model'],
    ['C:\\Models\\big.gguf', 'model'],
    ['C:\\Whatever\\Unknown\\thing.dat', 'other']
  ] as const)('%s -> %s', (p, g) => {
    expect(classifyPath(p)).toBe(g)
  })

  it('§16 🔴 禁止组：系统关键路径必须落在 forbidden', () => {
    expect(RISK_BY_GROUP[classifyPath('C:\\Windows\\System32\\x')]).toBe('forbidden')
    expect(RISK_BY_GROUP[classifyPath('C:\\Windows\\WinSxS\\x')]).toBe('forbidden')
    expect(RISK_BY_GROUP[classifyPath('C:\\Windows\\Installer\\x.msi')]).toBe('forbidden')
    expect(RISK_BY_GROUP[classifyPath('C:\\$Recycle.Bin\\S-1-5\\x')]).not.toBe('safe')
  })

  it('§16 🟢 安全组 vs 🟡 谨慎组', () => {
    expect(RISK_BY_GROUP[classifyPath('C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp')]).toBe('safe')
    expect(RISK_BY_GROUP[classifyPath('C:\\Users\\Kano\\.npm\\cache\\x')]).toBe('caution')
  })

  it('模型文件归 model（§21：必须归大文件，不得自动删）', () => {
    expect(RISK_BY_GROUP[classifyPath('C:\\m\\q.safetensors')]).toBe('high')
  })

  it('大小写与正斜杠输入都能分类', () => {
    expect(classifyPath('c:/users/kano/appdata/local/temp')).toBe('temp')
  })
})
