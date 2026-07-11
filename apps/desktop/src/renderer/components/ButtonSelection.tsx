import { cn } from "../utils/cn";

export interface ButtonSelectionProps {
	readonly options: ReadonlyArray<string>;
	readonly active: string;
	readonly onSelect?: (option: string) => void;
	readonly columns?: number;
	readonly className?: string;
}

export const ButtonSelection = ({
	options,
	active,
	onSelect,
	columns,
	className,
}: ButtonSelectionProps) => (
	<div
		className={cn(columns ? "grid" : "flex flex-wrap", "gap-1", className)}
		style={columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}
	>
		{options.map((option) => (
			<button
				key={option}
				type="button"
				onClick={() => onSelect?.(option)}
				className={cn(
					"type-label flex-auto cursor-pointer rounded-xs px-2 py-1 text-center",
					option === active
						? "bg-text-primary text-surface"
						: "text-text-secondary hover:text-text-primary",
				)}
				aria-label={option}
			>
				{option}
			</button>
		))}
	</div>
);
