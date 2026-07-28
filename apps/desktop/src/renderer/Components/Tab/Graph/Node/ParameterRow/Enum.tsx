import { ButtonSelection } from "../../../../UI/ButtonSelection";
import { Select } from "../../../../UI/Select";
import { FieldRow } from "./FieldRow";

export interface EnumParameter {
	readonly kind: "enum";
	readonly name: string;
	readonly value: string;
	readonly options: ReadonlyArray<string>;
	readonly optional: boolean;
	readonly defined: boolean;
}

export function EnumRow({
	param,
	dimmed,
	onParameterChange,
	onParameterUnset,
}: {
	readonly param: EnumParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterUnset?: (name: string) => void;
}) {
	const useButtons = param.options.every((opt) => opt.length <= 10);

	return (
		<FieldRow
			param={param}
			dimmed={dimmed}
			className="flex flex-col"
			controlClassName="mt-1"
			onParameterChange={onParameterChange}
			onParameterUnset={onParameterUnset}
		>
			{useButtons ? (
				<ButtonSelection
					active={param.value}
					options={param.options}
					onSelect={onParameterChange ? (option) => onParameterChange(param.name, option) : undefined}
				/>
			) : (
				<Select
					value={param.value}
					options={param.options}
					onChange={onParameterChange ? (option) => onParameterChange(param.name, option) : undefined}
				/>
			)}
		</FieldRow>
	);
}
