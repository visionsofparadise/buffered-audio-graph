import type { LeafParameter } from "../utils/buildParameters";
import { BooleanRow } from "./Boolean";
import { EnumRow } from "./Enum";
import { FileRow } from "./File";
import { NumberRow } from "./Number";
import { StringRow } from "./String";

export function LeafField({
	param,
	dimmed,
	disabled,
	onParameterChange,
	onParameterBrowse,
	onParameterUnset,
	onFileOpen,
	statFile,
	renderEpoch,
}: {
	readonly param: LeafParameter;
	readonly dimmed?: boolean;
	readonly disabled?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterBrowse?: (name: string) => void;
	readonly onParameterUnset?: (name: string) => void;
	readonly onFileOpen?: (value: string) => void;
	readonly statFile?: (value: string) => Promise<boolean>;
	readonly renderEpoch?: number;
}) {
	switch (param.kind) {
		case "number":
			return (
				<NumberRow
					param={param}
					dimmed={dimmed}
					disabled={disabled}
					onParameterChange={onParameterChange}
					onParameterUnset={onParameterUnset}
				/>
			);

		case "boolean":
			return (
				<BooleanRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
					onParameterUnset={onParameterUnset}
				/>
			);

		case "enum":
			return (
				<EnumRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
					onParameterUnset={onParameterUnset}
				/>
			);

		case "file":
			return (
				<FileRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
					onParameterBrowse={onParameterBrowse}
					onParameterUnset={onParameterUnset}
					onOpen={onFileOpen}
					statFile={statFile}
					renderEpoch={renderEpoch}
				/>
			);

		case "string":
			return (
				<StringRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
					onParameterUnset={onParameterUnset}
				/>
			);
	}
}
