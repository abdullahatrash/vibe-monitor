/**
 * Shared IPC contract between the Electron main process and the renderer, split by
 * domain (quality-review slice 5). Each domain module owns BOTH its channel entries
 * and its Args/Result types, co-located so the wire name and its payload docs live
 * together; this barrel assembles the single `IPC` const from the per-domain channel
 * fragments and re-exports every type, so `import … from '../shared/ipc'` (the
 * directory index) resolves exactly as the old single file did.
 *
 * Keep this whole directory free of Node/DOM imports so both sides can consume it
 * (both tsconfig projects compile it).
 */
import { coreChannels } from './core'
import { threadChannels } from './thread'
import { authChannels } from './auth'
import { gitChannels } from './git'
import { ghChannels } from './gh'
import { filesChannels } from './files'

/**
 * The one typed channel map. ONE exported object — the channel names are the wire
 * contract, so the keys + string values must never change. Assembled by domain; the
 * spread of each `as const` fragment preserves the literal channel strings.
 */
export const IPC = {
  ...coreChannels,
  ...authChannels,
  ...threadChannels,
  ...gitChannels,
  ...ghChannels,
  ...filesChannels,
} as const

export * from './core'
export * from './thread'
export * from './auth'
export * from './git'
export * from './gh'
export * from './files'
