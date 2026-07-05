import { cn } from "../../../../../../utils/cn";

/**
 * Render a camelCase schema field name as spaced words. `type-label` then
 * uppercases it for display (`pluginPath` → "PLUGIN PATH").
 */
export function humanizeFieldName(name: string): string {
	return name.replace(/([A-Z])/g, " $1").trim();
}

/**
 * Class for a parameter-row label. 12px (`text-xs`) so a param name reads at
 * the same scale as the node's other functional text. An incomplete param —
 * one the user still needs to fill — renders its label in `accent-primary`
 * (the coral attention treatment); a complete param is `text-secondary`.
 */
export function paramLabelClass(complete: boolean): string {
	return cn(
		"type-label text-xs",
		complete ? "text-text-secondary" : "text-accent-primary",
	);
}
