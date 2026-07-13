import { FileInput } from "../../../../FileInput";
import { IconButton } from "../../../../IconButton";
import { cn } from "../../../../../utils/cn";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { FieldLabel } from "./FieldLabel";

export interface FileParameter {
	readonly kind: "file";
	readonly name: string;
	readonly value: string;
	readonly optional: boolean;
	readonly defined: boolean;
	/** Dialog mode from the schema meta — "save" params get the open-output button. */
	readonly mode?: "open" | "save";
}

export function FileRow({
	param,
	dimmed,
	onParameterChange,
	onParameterBrowse,
	onParameterUnset,
	onOpen,
	statFile,
	renderEpoch,
}: {
	readonly param: FileParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterBrowse?: (name: string) => void;
	readonly onParameterUnset?: (name: string) => void;
	/** Open the current value in the OS default app. Only wired for save-mode rows. */
	readonly onOpen?: (value: string) => void;
	/** Resolves true when the value names an existing file — drives the open button's enabled state. */
	readonly statFile?: (value: string) => Promise<boolean>;
	/** Bumped when a render completes, re-triggering the existence check. */
	readonly renderEpoch?: number;
}) {
	const complete = param.value !== "";
	const controlDisabled = param.optional && !param.defined;
	const isSaveMode = param.mode === "save";
	const setDefinedHandler = onParameterChange || onParameterUnset
		? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
		: undefined;

	const [openEnabled, setOpenEnabled] = useState(false);

	useEffect(() => {
		if (!isSaveMode || !statFile || param.value === "") {
			setOpenEnabled(false);

			return;
		}

		let cancelled = false;

		statFile(param.value)
			.then((exists) => {
				if (!cancelled) setOpenEnabled(exists);
			})
			.catch(() => {
				if (!cancelled) setOpenEnabled(false);
			});

		return () => {
			cancelled = true;
		};
	}, [isSaveMode, statFile, param.value, renderEpoch]);

	return (
		<div className={cn("flex flex-col", dimmed && "opacity-40")}>
			<FieldLabel
				name={param.name}
				optional={param.optional}
				defined={param.defined}
				complete={complete}
				onSetDefined={setDefinedHandler}
			/>
			<div className={cn("mt-1 flex items-center gap-1", controlDisabled && "pointer-events-none opacity-40")}>
				<FileInput
					className="flex-1"
					key={param.value}
					defaultValue={param.value}
					placeholder="No file selected"
					onChange={onParameterChange ? (next) => onParameterChange(param.name, next) : undefined}
					onBrowse={onParameterBrowse ? () => onParameterBrowse(param.name) : undefined}
				/>
				{isSaveMode && openEnabled && onOpen && (
					<IconButton
						icon={ExternalLink}
						label="Open output"
						variant="ghost"
						size="md"
						onClick={() => onOpen(param.value)}
					/>
				)}
			</div>
		</div>
	);
}
