import { type JSX } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type {
  ThreadConfigAxis,
  ThreadModes,
  ThreadModels,
  ThreadReasoningEffort,
} from '../../../shared/ipc'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
import { cn } from '../lib/utils'

/**
 * The composer's agent-controls row (#66): Mode / Model / Reasoning-effort pickers,
 * each showing the Thread's current value and a base-ui menu of its options. Vibe-
 * owned, display-from-session-state (ADR-0007): the current values come from the
 * connection (sourced from `session/new`), and a pick fires `onSetConfig` which App
 * reflects OPTIMISTICALLY and reverts on failure — a change emits no notification.
 *
 * `disabled` is the between-turns + bound-session gate (a turn streaming OR no bound
 * session yet) — the controls grey out rather than letting a mid-turn / pre-session
 * change through. The row renders nothing when the agent advertises no axes at all.
 */
export function AgentControls({
  modes,
  models,
  reasoningEffort,
  disabled,
  onSetConfig,
}: {
  modes: ThreadModes | null
  models: ThreadModels | null
  reasoningEffort: ThreadReasoningEffort | null
  disabled: boolean
  onSetConfig: (axis: ThreadConfigAxis, value: string) => void
}): JSX.Element | null {
  if (!modes && !models && !reasoningEffort) return null
  return (
    <div className="composer__controls flex flex-wrap items-center gap-2">
      {modes && (
        <AgentControl
          label="Mode"
          current={modes.currentModeId}
          options={modes.availableModes.map((m) => ({ value: m.id, label: m.name }))}
          disabled={disabled}
          onSelect={(value) => onSetConfig('mode', value)}
        />
      )}
      {models && (
        <AgentControl
          label="Model"
          current={models.currentModelId}
          options={models.availableModels.map((m) => ({ value: m.modelId, label: m.name }))}
          disabled={disabled}
          onSelect={(value) => onSetConfig('model', value)}
        />
      )}
      {reasoningEffort && (
        <AgentControl
          label="Reasoning effort"
          current={reasoningEffort.current}
          options={reasoningEffort.options.map((o) => ({ value: o.value, label: o.name ?? titleCase(o.value) }))}
          disabled={disabled}
          onSelect={(value) => onSetConfig('reasoningEffort', value)}
        />
      )}
    </div>
  )
}

interface ControlOption {
  value: string
  label: string
}

/**
 * One labelled picker. base-ui owns focus / keyboard nav / dismissal; this layers
 * on the brand look (square corners, surface + border, accent hover) and a leading
 * check on the active option. `disabled` greys the trigger and stops it opening.
 */
function AgentControl({
  label,
  current,
  options,
  disabled,
  onSelect,
}: {
  label: string
  current: string | null
  options: ControlOption[]
  disabled: boolean
  onSelect: (value: string) => void
}): JSX.Element {
  const currentLabel = options.find((o) => o.value === current)?.label ?? current ?? '—'
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        title={label}
        className={cn(
          'flex items-center gap-1.5 border border-border bg-surface px-2 py-1 text-xs text-text',
          'hover:bg-accent hover:text-on-accent',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface disabled:hover:text-text',
        )}
      >
        <span className="text-muted">{label}</span>
        <span className="font-medium">{currentLabel}</span>
        <ChevronDown size={12} aria-hidden />
      </MenuTrigger>
      <MenuContent align="start">
        {options.map((o) => (
          <MenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <Check size={12} aria-hidden className={o.value === current ? 'opacity-100' : 'opacity-0'} />
            {o.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

/** Title-case a bare effort value (`off` -> `Off`) when the agent gives no `name`. */
function titleCase(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}
