import type { DeepCleanApi } from '../../shared/types'

declare global {
  interface Window {
    deepclean: DeepCleanApi
  }
}

export {}
