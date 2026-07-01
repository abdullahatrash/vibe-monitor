import { describe, expect, it } from 'vitest'
import { resolveWorkspacePath } from './resolve-workspace-path'

const WORKSPACE = '/Users/dev/project'
const HOME = '/Users/dev'

describe('resolveWorkspacePath', () => {
  it('passes an absolute path through unchanged', () => {
    expect(resolveWorkspacePath(WORKSPACE, '/etc/hosts', HOME)).toBe('/etc/hosts')
  })

  it('resolves a bare relative path against the Workspace cwd', () => {
    expect(resolveWorkspacePath(WORKSPACE, 'src/index.ts', HOME)).toBe(
      '/Users/dev/project/src/index.ts',
    )
  })

  it('resolves a `./`-prefixed path against the Workspace cwd', () => {
    expect(resolveWorkspacePath(WORKSPACE, './README.md', HOME)).toBe(
      '/Users/dev/project/README.md',
    )
  })

  it('normalizes `..` segments against the Workspace cwd', () => {
    expect(resolveWorkspacePath(WORKSPACE, '../sibling/file.ts', HOME)).toBe(
      '/Users/dev/sibling/file.ts',
    )
  })

  it('expands a `~/`-prefixed path against the home directory', () => {
    expect(resolveWorkspacePath(WORKSPACE, '~/notes/todo.md', HOME)).toBe(
      '/Users/dev/notes/todo.md',
    )
  })

  it('expands a bare `~` to the home directory', () => {
    expect(resolveWorkspacePath(WORKSPACE, '~', HOME)).toBe(HOME)
  })

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveWorkspacePath(WORKSPACE, '  src/app.ts  ', HOME)).toBe(
      '/Users/dev/project/src/app.ts',
    )
  })
})
