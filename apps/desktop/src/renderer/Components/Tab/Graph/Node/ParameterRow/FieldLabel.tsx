import { Check } from "lucide-react";
import { cn } from "../../../../../utils/cn";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";

export function FieldLabel({
	name,
	optional,
	defined,
	complete = true,
	onSetDefined,
}: {
	readonly name: string;
	readonly optional: boolean;
	readonly defined: boolean;
	readonly complete?: boolean;
	readonly onSetDefined?: (defined: boolean) => void;
}) {
	return (
		<span className="inline-flex items-center gap-1.5">
			{optional && onSetDefined && (
				<button
					type="button"
					role="checkbox"
					aria-checked={defined}
					title={defined ? "Set — uncheck to auto-derive" : "Auto-derived — check to set a value"}
					onClick={() => onSetDefined(!defined)}
					className={cn(
						"flex size-3.5 shrink-0 items-center justify-center rounded-xs border",
						defined ? "border-text-primary bg-text-primary text-surface" : "border-border text-transparent",
					)}
				>
					<Check size={10} strokeWidth={3} />
				</button>
			)}
			<span className={paramLabelClass(complete)}>{humanizeFieldName(name)}</span>
		</span>
	);
}
