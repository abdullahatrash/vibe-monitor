import { describe, expect, it } from 'vitest'
import { isWithinDir } from './open-target'

const ROOT = '/Users/dev/project'

describe('isWithinDir', () => {
  it('accepts a file directly inside the dir', () => {
    expect(isWithinDir(ROOT, '/Users/dev/project/src/app.ts')).toBe(true)
  })

  it('accepts the dir itself', () => {
    expect(isWithinDir(ROOT, ROOT)).toBe(true)
  })

  it('rejects a path outside the dir', () => {
    expect(isWithinDir(ROOT, '/etc/passwd')).toBe(false)
    expect(isWithinDir(ROOT, '/Users/dev/.ssh/id_rsa')).toBe(false)
  })

  it('rejects a parent-directory escape', () => {
    expect(isWithinDir(ROOT, '/Users/dev/sibling/file.ts')).toBe(false)
  })

  it('rejects a sibling dir that shares a name prefix', () => {
    expect(isWithinDir(ROOT, '/Users/dev/project-evil/file.ts')).toBe(false)
  })

  it('rejects everything for an empty dir', () => {
    expect(isWithinDir('', '/anything')).toBe(false)
  })
})
