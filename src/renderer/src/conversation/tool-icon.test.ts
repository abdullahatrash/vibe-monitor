import { describe, it, expect } from 'vitest'
import { toolKindIcon } from './tool-icon'

/**
 * ToolRow tone-icon name resolution (#115): ACP tool `kind` → lucide icon name.
 * Pure — the JSX switch that turns a name into a component isn't tested here.
 */
describe('toolKindIcon', () => {
  it('maps the core ACP kinds', () => {
    expect(toolKindIcon('read')).toBe('eye')
    expect(toolKindIcon('edit')).toBe('square-pen')
    expect(toolKindIcon('execute')).toBe('terminal')
    expect(toolKindIcon('fetch')).toBe('globe')
    expect(toolKindIcon('think')).toBe('brain')
    expect(toolKindIcon('delete')).toBe('trash')
    expect(toolKindIcon('move')).toBe('move')
    expect(toolKindIcon('search')).toBe('search')
  })

  it('accepts loose synonyms Vibe may emit', () => {
    expect(toolKindIcon('command')).toBe('terminal')
    expect(toolKindIcon('web')).toBe('globe')
  })

  it('falls back to wrench for `other`, unknown, or missing kinds', () => {
    expect(toolKindIcon('other')).toBe('wrench')
    expect(toolKindIcon('mcp_custom_thing')).toBe('wrench')
    expect(toolKindIcon(null)).toBe('wrench')
    expect(toolKindIcon(undefined)).toBe('wrench')
  })
})
