import { type JSX } from 'react'
import { Check, ChevronDown, Cpu, Shield, Sliders, type LucideIcon } from 'lucide-react'
import type {
  ThreadConfigAxis,
  ThreadModes,
  ThreadModels,
  ThreadReasoningEffort,
} from '../../../shared/ipc'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
import { cn } from '../lib/utils'

/**
 * The composer's agent-controls (#66): Mode / Model / Reasoning-effort pickers,
 * each showing the Thread's current value and a base-ui menu of its options. Vibe-
 * owned, display-from-session-state (ADR-0007): the current values come from the
 * connection (sourced from `session/new`), and a pick fires `onSetConfig` which App
 * reflects OPTIMISTICALLY and reverts on failure — a change emits no notification.
 *
 * Restyled to the design system (#117): borderless `icon + label + chevron` chips
 * that live inline in the composer card's control row (per the prototype), not a
 * bordered pill row. `disabled` is the between-turns gate — true only WHILE a turn
 * streams (a pre-prompt draft is NOT processing, so its pickers are live: #75 lets the
 * user pre-select before a session exists, and App caches the pick to apply on the
 * first bind). The row renders nothing when the agent advertises no axes at all.
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
    <div className="flex flex-wrap items-center gap-1">
      {modes && (
        <AgentControl
          label="Mode"
          icon={Shield}
          current={modes.currentModeId}
          options={modes.availableModes.map((m) => ({ value: m.id, label: m.name }))}
          disabled={disabled}
          onSelect={(value) => onSetConfig('mode', value)}
        />
      )}
      {models && (
        <AgentControl
          label="Model"
          icon={Cpu}
          current={models.currentModelId}
          options={models.availableModels.map((m) => ({ value: m.modelId, label: m.name }))}
          disabled={disabled}
          onSelect={(value) => onSetConfig('model', value)}
        />
      )}
      {reasoningEffort && (
        <AgentControl
          label="Reasoning effort"
          icon={Sliders}
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
 * One borderless picker chip. base-ui owns focus / keyboard nav / dismissal; this
 * layers on the brand chip look (muted `icon + label + chevron`, accent-text hover)
 * and a leading check on the active option. `disabled` greys the trigger and stops
 * it opening.
 */
function AgentControl({
  label,
  icon: Icon,
  current,
  options,
  disabled,
  onSelect,
}: {
  label: string
  icon?: LucideIcon
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
        aria-label={label}
        title={label}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm text-text-body outline-none transition-colors',
          'hover:text-accent-text',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-text-body',
          '[&_svg]:pointer-events-none [&_svg]:shrink-0',
        )}
      >
        {Icon && <Icon className="size-4 text-muted" aria-hidden />}
        <span className="font-medium">{currentLabel}</span>
        <ChevronDown className="size-3.5 text-faint" aria-hidden />
      </MenuTrigger>
      <MenuContent align="start">
        {options.map((o) => (
          <MenuItem key={o.value} onClick={() => onSelect(o.value)}>
            <Check
              className={cn('size-3.5', o.value === current ? 'opacity-100' : 'opacity-0')}
              aria-hidden
            />
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
