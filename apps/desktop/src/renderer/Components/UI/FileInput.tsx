import { FolderOpen } from "lucide-react";
import { cn } from "../../utils/cn";
import { IconButton } from "./IconButton";
import type { KeyboardEvent } from "react";

export interface FileInputProps {
	readonly value?: string;
	readonly defaultValue?: string;
	readonly placeholder?: string;
	readonly label?: string;
	readonly onChange?: (value: string) => void;
	readonly onBlur?: () => void;
	readonly onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
	readonly onBrowse?: () => void;
	readonly className?: string;
}

export function FileInput({
	value,
	defaultValue,
	placeholder,
	label,
	onChange,
	onBlur,
	onKeyDown,
	onBrowse,
	className,
}: FileInputProps) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			{label && <span className="type-label text-text-secondary">{label}</span>}
			<div className="flex items-center gap-1">
				<input
					type="text"
					value={value}
					defaultValue={defaultValue}
					placeholder={placeholder}
					onChange={onChange ? (event) => onChange(event.target.value) : undefined}
					onBlur={onBlur}
					onKeyDown={onKeyDown}
					className="min-w-0 flex-1 rounded-xs bg-surface px-2 py-1 text-body text-text-primary outline-none placeholder:text-dimmed"
				/>
				<IconButton icon={FolderOpen} label="Browse for file" variant="ghost" size="sm" onClick={onBrowse} />
			</div>
		</div>
	);
}
