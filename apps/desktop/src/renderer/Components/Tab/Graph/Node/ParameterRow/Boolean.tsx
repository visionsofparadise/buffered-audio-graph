import { Toggle } from "../../../../UI/Toggle";
import { FieldRow } from "./FieldRow";

export interface BooleanParameter {
	readonly kind: "boolean";
	readonly name: string;
	readonly value: boolean;
	readonly optional: boolean;
	readonly defined: boolean;
}

export function BooleanRow({
	param,
	dimmed,
	onParameterChange,
	onParameterUnset,
}: {
	readonly param: BooleanParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterUnset?: (name: string) => void;
}) {
	return (
		<FieldRow
			param={param}
			dimmed={dimmed}
			className="flex items-center justify-between gap-3"
			controlClassName="shrink-0"
			onParameterChange={onParameterChange}
			onParameterUnset={onParameterUnset}
		>
			<Toggle
				value={param.value}
				label={param.value ? "ON" : "OFF"}
				onChange={onParameterChange ? (toggled) => onParameterChange(param.name, toggled) : undefined}
			/>
		</FieldRow>
	);
}
