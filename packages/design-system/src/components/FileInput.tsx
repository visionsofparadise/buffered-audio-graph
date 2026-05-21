import { FolderOpen } from "lucide-react";
import { cn } from "../cn";
import { Input } from "./Input";
import { IconButton } from "./IconButton";

export interface FileInputProps {
	readonly value?: string;
	readonly defaultValue?: string;
	readonly placeholder?: string;
	readonly label?: string;
	readonly onChange?: (value: string) => void;
	/** Invoked by the browse button — opens the OS file picker in the desktop app. */
	readonly onBrowse?: () => void;
	readonly className?: string;
}

/**
 * FileInput — a text field for a filesystem path plus a browse button.
 *
 * For schema params whose text value is a "file" type. The browse button
 * opens the OS file picker in the desktop app; in the design-system demo it
 * is a no-op affordance. The field itself stays editable so a path can also
 * be typed or pasted directly.
 */
export function FileInput({
	value,
	defaultValue,
	placeholder,
	label,
	onChange,
	onBrowse,
	className,
}: FileInputProps) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			{label && <span className="type-label text-text-secondary">{label}</span>}
			<div className="flex items-center gap-1">
				<Input
					type="text"
					value={value}
					defaultValue={defaultValue}
					placeholder={placeholder}
					onChange={onChange}
					className="min-w-0 flex-1"
				/>
				<IconButton
					icon={FolderOpen}
					label="Browse for file"
					variant="ghost"
					size="sm"
					onClick={onBrowse}
				/>
			</div>
		</div>
	);
}
