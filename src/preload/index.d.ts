import type { VibeMistroApi } from './index'

declare global {
  interface Window {
    api: VibeMistroApi
  }
}

export {}
