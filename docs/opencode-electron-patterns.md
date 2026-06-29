# opencode Electron patterns

opencode's desktop app (`/Users/abdullahatrash/mistral/opencode/packages/desktop`) is the same
stack as us — **electron-vite + Bun**, main/preload/renderer split (they use SolidJS; we use React,
but main/preload/IPC is framework-agnostic). This is our clean-code template. File refs below are
relative to that package.

---

## 1. Process model & startup (`src/main/index.ts`, `initialization.ts`, `windows.ts`)

- Startup is sequenced: `app.whenReady()` → set userData path (channel-specific) **before** any
  store is created → init logging → start backend → **create window only once backend is ready**.
- **Set `app.setPath('userData', …)` before instantiating any `electron-store`** — otherwise the
  store writes to the wrong dir.
- Single main window (module-level `mainWindow`), single-instance lock, deep-link queue until ready.
- `electron-window-state` persists window size/position.
- Per-window state via `WeakMap` (theme, zoom) → auto-cleanup on GC.

→ **For us:** detect `vibe`/`vibe-acp` and init store/logging before opening the window; show the
window after the environment check resolves.

---

## 2. Backend / sidecar (`src/main/server.ts`, `sidecar.ts`, `apps.ts`)

opencode runs its backend as an **Electron `UtilityProcess`** (an HTTP server, password-auth, CORS
`oc://renderer`), talking to the parent via `postMessage`. Lifecycle:
- Spawn → wait for a `ready` message (timeout) → **health-poll** an endpoint, racing the poll
  against process-exit so it fails fast if the child dies.
- Graceful stop: send `{type:'stop'}`, race an exit-message against a timeout, then `child.kill()`.
- Errors in the child are serialized `{message, stack}` and posted back to the parent.

→ **For us (stdio JSON-RPC, not HTTP):** we don't need the HTTP sidecar — each `vibe-acp` is already
its own child process, and `AcpClient` owns its stdio. **But adopt these ideas:**
- a **readiness signal** (the `initialize` response is our "ready"),
- **race start against early-exit** (don't hang if `vibe-acp` dies on spawn),
- **graceful stop with kill-timeout**,
- **serialize child errors** to the renderer.
- If we ever want crash-isolation beyond a child process, `UtilityProcess` is the tool.

---

## 3. Typed IPC — the most important pattern (`src/main/ipc.ts`, `src/preload/index.ts`, `preload/types.ts`)

End-to-end typing with **one interface as the contract**:

1. **Define the API interface once** (`preload/types.ts`): `ElectronAPI` lists every method with full
   signatures — not channel strings sprinkled around.
2. **Preload bridges it** (`preload/index.ts`): wrap `ipcRenderer.invoke/send/on` and
   `contextBridge.exposeInMainWorld('api', api)`. Three call shapes:
   - **request/response:** `foo: (x) => ipcRenderer.invoke('foo', x)` → returns a Promise.
   - **fire-and-forget:** `bar: (x) => ipcRenderer.send('bar', x)`.
   - **streaming/subscription:** `onThing: (cb) => { const h = (_,p)=>cb(p); ipcRenderer.on('thing', h);
     return () => ipcRenderer.removeListener('thing', h) }` — **always return an unsubscribe fn.**
3. **Main registers handlers** (`ipc.ts`): `ipcMain.handle('foo', (e, x) => …)`. Use **dependency
   injection** — `registerIpcHandlers(deps)` — instead of importing singletons, so handlers are
   testable. Get the sender window via `BrowserWindow.fromWebContents(e.sender)`.
4. **Main→renderer events:** `win.webContents.send(channel, payload)`.

**Subscription lifecycle (prevents leaks):** ref-count subscribers in preload; in main, track
listeners per renderer and clean up on `webContents` `destroyed` and on app `will-quit`.

→ **For us:** our `src/shared/ipc.ts` already centralizes channels + payload types; evolve it into a
single `VibeMistroApi` interface, keep the unsubscribe-returning pattern (already used for
`onAcpEvent`), and switch handler registration to a DI `registerIpc(deps)` once handlers grow.

**Security (non-negotiable):** `contextIsolation: true`, `nodeIntegration: false`, `sandbox` on,
all Node work behind IPC, no `fs` in the renderer. (We already set the first two; revisit `sandbox`.)

---

## 4. Persistence (`src/main/store.ts`, `store-keys.ts`, `migrate.ts`)

- **Lazy-create** `electron-store` instances in a `Map<name, Store>` — never at module load
  (userData path isn't set yet).
- Separate stores per domain (`opencode.settings`, `opencode.updater`).
- **Key constants** in `store-keys.ts` — no stringly-typed keys scattered around.
- Expose generic `store-get/set/delete/keys` over IPC; renderer never touches disk.
- One-time **migration** guarded by a flag in the store; `store.has(key)` before overwriting.

---

## 5. Updates & logging (`updater*.ts`, `logging.ts`)

- **Updater** = `electron-updater` behind a small **state machine** (`idle→checking→downloading→
  ready`), one op at a time, subscribers notified per transition, `autoDownload:false`. Stop the
  backend gracefully before `quitAndInstall`.
- **Logging** = `electron-log` v5, file transport, **scoped per process** (main/renderer/sidecar),
  per-run log directory under `<userData>/logs/<timestamp>/`, auto-delete logs older than N days.
  Crash reporter + optional netLog; **debug export** zips current-run logs + a manifest.

---

## 6. Shell env (`src/main/shell-env.ts`)

Packaged apps launched from Finder/Dock don't inherit shell PATH. opencode probes the user's shell:
`$SHELL -il -c 'env -0'`, falls back to `-l`, parses null-delimited output, 5s timeout, skips
nushell. → **We already ported this** to `src/main/shell-env.ts`; it backs detection + spawning.

---

## 7. Build & packaging (`electron.vite.config.ts`, `electron-builder.config.ts`, `scripts/`)

- electron-vite: three builds (main/preload/renderer); **externalize native deps** (e.g. node-pty)
  via `externalizeDepsPlugin`; preload as CommonJS when needed.
- **electron-builder** per **channel** (dev/beta/prod) with distinct app IDs (→ distinct userData);
  mac DMG+ZIP (signed/notarized), Windows NSIS, Linux AppImage/DEB/RPM; publish to GitHub.
- Native deps (`node-pty`) shipped as platform-specific `optionalDependencies`, resolved by a vite
  plugin.

→ **For us:** add `electron-builder` when we reach the packaging milestone; until then `bun run
build` is enough.

---

## 8. Menus, attachments, unresponsive (`menu.ts`, `attachment-picker.ts`, `unresponsive.ts`)

- **Menu** (macOS): data-driven — map entries to native `role` / IPC `command` / `action` handler /
  `href`→`shell.openExternal`.
- **Attachment picker:** **token-based authorization** — picking files returns a random token + list
  with a size budget; reads validate token + sender + path, decrement budget, auto-cleanup. Prevents
  arbitrary renderer file reads. **Adopt this for our image attachments.**
- **Unresponsive handler:** sample `collectJavaScriptCallStack()` during freezes, log the most
  frequent stacks. Nice-to-have for diagnostics.

---

## 9. What makes it clean (adopt as rules)

- **Separation:** main = Node/OS/process work; preload = typed bridge only; renderer = UI only.
- **One typed contract** (`ElectronAPI`) between processes; no ad-hoc channel strings.
- **Dependency injection** for handlers → testable, no hidden singletons.
- **Always return unsubscribe** from subscriptions; clean up on destroy + quit.
- **Lazy init** ordering: userData path → store/logging → backend → window.
- **Log, don't swallow**; serialize child/process errors to the surface.
- **Verb-prefixed function names**, `kebab-case` files, `SCREAMING_SNAKE` constants, named exports.
