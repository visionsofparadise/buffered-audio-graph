import { cn } from "../../../../../../utils/cn";

export function humanizeFieldName(name: string): string {
	return name.replace(/([A-Z])/g, " $1").trim();
}

export function paramLabelClass(complete: boolean): string {
	return cn(
		"type-label text-xs",
		complete ? "text-text-secondary" : "text-error",
	);
}
