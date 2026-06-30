/// <reference types="vite/client" />

// Pulls in Vite's client ambient types — notably the `*?worker` module shape used by
// `@pierre/diffs/worker/worker.js?worker` (#85). Vite/electron-vite compile that import
// to a worker-constructor default export; without this reference the renderer tsconfig
// (`types: ["node"]`) has no declaration for the `?worker` query suffix.
