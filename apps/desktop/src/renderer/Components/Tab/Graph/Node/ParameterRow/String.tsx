import { Input } from "../../../../UI/Input";
import { FieldRow } from "./FieldRow";
import { useCommittedText } from "./hooks/useCommittedText";

export interface StringParameter {
	readonly kind: "string";
	readonly name: string;
	readonly value: string;
	readonly optional: boolean;
	readonly defined: boolean;
}

export function StringRow({
	param,
	dimmed,
	onParameterChange,
	onParameterUnset,
}: {
	readonly param: StringParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterUnset?: (name: string) => void;
}) {
	const text = useCommittedText(
		param.value,
		onParameterChange ? (next) => onParameterChange(param.name, next) : undefined,
	);

	return (
		<FieldRow
			param={param}
			dimmed={dimmed}
			className="flex flex-col"
			controlClassName="mt-1"
			onParameterChange={onParameterChange}
			onParameterUnset={onParameterUnset}
		>
			<Input type="text" {...text} className="w-full" />
		</FieldRow>
	);
}
