import type { VibeMonitorApi } from './index'

declare global {
  interface Window {
    api: VibeMonitorApi
  }
}

export {}
