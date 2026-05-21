import { cn } from "../cn";

export interface ToggleProps {
	readonly value: boolean;
	readonly label?: string;
	readonly onChange?: (value: boolean) => void;
	readonly className?: string;
}

export function Toggle({
	value,
	label,
	onChange,
	className,
}: ToggleProps) {
	return (
		<button
			type="button"
			onClick={() => onChange?.(!value)}
			className={cn(
				"type-label inline-flex items-center justify-center rounded-xs px-2 py-1",
				value
					? "bg-text-primary text-surface"
					: "bg-elevated text-text-secondary",
				className,
			)}
		>
			{label}
		</button>
	);
}
