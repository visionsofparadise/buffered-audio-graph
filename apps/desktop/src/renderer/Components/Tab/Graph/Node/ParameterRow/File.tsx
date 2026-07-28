import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { FileInput } from "../../../../UI/FileInput";
import { IconButton } from "../../../../UI/IconButton";
import { FieldRow } from "./FieldRow";
import { useCommittedText } from "./hooks/useCommittedText";

export interface FileParameter {
	readonly kind: "file";
	readonly name: string;
	readonly value: string;
	readonly optional: boolean;
	readonly defined: boolean;
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
	readonly onOpen?: (value: string) => void;
	readonly statFile?: (value: string) => Promise<boolean>;
	readonly renderEpoch?: number;
}) {
	const text = useCommittedText(
		param.value,
		onParameterChange ? (next) => onParameterChange(param.name, next) : undefined,
	);

	const isSaveMode = param.mode === "save";

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
		<FieldRow
			param={param}
			dimmed={dimmed}
			complete={param.value !== ""}
			className="flex flex-col"
			controlClassName="mt-1 flex items-center gap-1"
			onParameterChange={onParameterChange}
			onParameterUnset={onParameterUnset}
		>
			<FileInput
				className="flex-1"
				{...text}
				placeholder="No file selected"
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
		</FieldRow>
	);
}
