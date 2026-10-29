import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkSubtree } from '../../core/scan/walk'
import { nodeFs } from '../../core/fs/fslike'

const base = { fs: nodeFs, concurrency: 8, maxDepth: 64, isCancelled: () => false }

describe('walk on real NTFS', () => {
  it('超过 260 字符的深层目录能扫到底（长路径前缀真实生效）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dc-long-'))
    let deep = dir
    for (let i = 0; i < 12; i++) {
      deep = join(deep, 'segment-with-many-chars')
      await mkdir(deep)
    }
    await writeFile(join(deep, 'deep.bin'), Buffer.alloc(4096))
    const r = await walkSubtree(dir, base)
    expect(r.size).toBeGreaterThanOrEqual(4096)
    expect(r.fileCount).toBe(1)
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
  }, 120000)
})
