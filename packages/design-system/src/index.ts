/* eslint-disable barrel-files/avoid-barrel-files */
// Components — Controls
export { Knob } from "./components/controls/Knob";
export type { KnobProps } from "./components/controls/Knob";
export { Fader } from "./components/controls/Fader";
export type { FaderProps } from "./components/controls/Fader";
export { Meter } from "./components/controls/Meter";
export type { MeterProps } from "./components/controls/Meter";
export { ButtonSelection } from "./components/controls/ButtonSelection";
export type { ButtonSelectionProps } from "./components/controls/ButtonSelection";

// Components — Primitives
export { Button } from "./components/Button";
export type { ButtonProps } from "./components/Button";
export { IconButton } from "./components/IconButton";
export type { IconButtonProps } from "./components/IconButton";
export { Input } from "./components/Input";
export type { InputProps } from "./components/Input";
export { FileInput } from "./components/FileInput";
export type { FileInputProps } from "./components/FileInput";
export { Select } from "./components/Select";
export type { SelectProps } from "./components/Select";
export { Toggle } from "./components/Toggle";
export type { ToggleProps } from "./components/Toggle";
export { DropdownButton } from "./components/DropdownButton";
export type { DropdownButtonProps, MenuItem } from "./components/DropdownButton";
export {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuGroup,
	DropdownMenuPortal,
	DropdownMenuSub,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
} from "./components/DropdownMenu";

// Color constants (for canvas / Three.js contexts)
export {
	surface,
	elevated,
	border,
	dimmed,
	textSecondary,
	textPrimary,
	accentPrimary,
	accentSecondary,
	categorySource,
	categoryTransform,
	categoryTarget,
	meterGreen,
	meterYellow,
	light,
} from "./colors";

// Utilities
export { cn } from "./cn";
