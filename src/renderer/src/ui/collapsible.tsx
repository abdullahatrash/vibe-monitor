import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible'

/**
 * A thin re-export of base-ui's Collapsible (Root/Trigger/Panel). Behaviour is
 * headless — the "thinking"/reasoning block (#115, auto-open while streaming) and
 * any disclosure section style the trigger + panel at the call site. base-ui's
 * panel part is `Panel` (exported here as `CollapsibleContent` for the familiar
 * shadcn triad).
 */
export const Collapsible = BaseCollapsible.Root
export const CollapsibleTrigger = BaseCollapsible.Trigger
export const CollapsibleContent = BaseCollapsible.Panel
