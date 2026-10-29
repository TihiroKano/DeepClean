import { describe, expect, it } from 'vitest'
import { IPC } from '../../shared/constants'

describe('骨架', () => {
  it('shared 契约模块可被 node 端 import', () => {
    expect(IPC).toBeTypeOf('object')
  })
})
