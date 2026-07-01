/**
 * The shared primitive library (#111). Headless behaviour from `@base-ui/react`,
 * styled with Tailwind utilities resolved through OUR tokens (styles.css `@theme
 * inline`), composed via `cn()`, variants via CVA. This barrel enumerates every
 * primitive so feature areas know what exists — and gives tsc a consumer so the
 * whole kit is type-checked even before the areas migrate onto it (#113/#117–119).
 *
 * Consumers write `<Button variant="ghost">` / `<Chip>` / `<Panel>` — never
 * hand-rolled class strings. Add BEM nowhere; retire it area-by-area in later slices.
 */

export { Button, buttonVariants } from './button'
export { IconButton } from './icon-button'
export { Input } from './input'
export { Textarea } from './textarea'
export { Badge, badgeVariants } from './badge'
export { Chip } from './chip'

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogBackdrop,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './dialog'

export { Popover, PopoverTrigger, PopoverContent, PopoverTitle, PopoverDescription } from './popover'

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from './tooltip'

export { Collapsible, CollapsibleTrigger, CollapsibleContent } from './collapsible'

export { ScrollArea, ScrollBar } from './scroll-area'

export {
  Select,
  SelectValue,
  SelectGroup,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectGroupLabel,
  SelectSeparator,
} from './select'

export { Separator } from './separator'

export { Avatar, AvatarImage, AvatarFallback } from './avatar'

export { Spinner } from './spinner'

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card'

export { NavItem } from './nav-item'

export { Panel, PanelHeader, PanelTitle, PanelContent } from './panel'

export {
  Menu,
  MenuTrigger,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuRadioGroup,
  MenuRadioItem,
} from './menu'
