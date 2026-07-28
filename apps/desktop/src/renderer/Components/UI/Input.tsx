import { cn } from "../../utils/cn";
import type { KeyboardEvent } from "react";

export interface InputProps {
	readonly type?: "text" | "number";
	readonly label?: string;
	readonly value?: string;
	readonly defaultValue?: string;
	readonly placeholder?: string;
	readonly onChange?: (value: string) => void;
	readonly onBlur?: () => void;
	readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	readonly className?: string;
	readonly "data-render-param-input"?: string;
}

export function Input({
	type = "text",
	label,
	value,
	defaultValue,
	placeholder,
	onChange,
	onBlur,
	onKeyDown,
	className,
	"data-render-param-input": dataRenderParamInput,
}: InputProps) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			{label && <label className="type-label text-text-secondary">{label}</label>}
			<input
				type={type}
				value={value}
				defaultValue={defaultValue}
				placeholder={placeholder}
				onChange={onChange ? (event) => onChange(event.target.value) : undefined}
				onBlur={onBlur}
				onKeyDown={onKeyDown}
				data-render-param-input={dataRenderParamInput}
				className={cn(
					"h-9 bg-surface text-text-primary rounded-xs px-2.5 outline-none placeholder:text-dimmed focus:ring-1 focus:ring-accent-primary",
					type === "number" && "tabular-nums",
				)}
			/>
		</div>
	);
}
