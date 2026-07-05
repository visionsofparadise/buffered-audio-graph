import type { LeafParameter } from "../utils/buildParameters";
import { BooleanRow } from "./Boolean";
import { EnumRow } from "./Enum";
import { FileRow } from "./File";
import { NumberRow } from "./Number";
import { StringRow } from "./String";

/**
 * Renders a single leaf parameter (number, boolean, enum, file, string).
 * Used by ArrayRow to render row fields with pre-computed callbacks, and by
 * ParameterField as the leaf-case dispatcher.
 */
export function LeafField({
	param,
	dimmed,
	disabled,
	onParameterChange,
	onParameterBrowse,
}: {
	readonly param: LeafParameter;
	readonly dimmed?: boolean;
	readonly disabled?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterBrowse?: (name: string) => void;
}) {
	switch (param.kind) {
		case "number":
			return (
				<NumberRow
					param={param}
					dimmed={dimmed}
					disabled={disabled}
					onParameterChange={onParameterChange}
				/>
			);

		case "boolean":
			return (
				<BooleanRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
				/>
			);

		case "enum":
			return (
				<EnumRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
				/>
			);

		case "file":
			return (
				<FileRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
					onParameterBrowse={onParameterBrowse}
				/>
			);

		case "string":
			return (
				<StringRow
					param={param}
					dimmed={dimmed}
					onParameterChange={onParameterChange}
				/>
			);
	}
}
