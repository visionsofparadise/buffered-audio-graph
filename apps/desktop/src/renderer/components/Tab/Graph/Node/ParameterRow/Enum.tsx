import { ButtonSelection } from "../../../../ButtonSelection";
import { Select } from "../../../../Select";
import { cn } from "../../../../../utils/cn";
import { FieldLabel } from "./FieldLabel";

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
	const controlDisabled = param.optional && !param.defined;
	const setDefinedHandler = onParameterChange || onParameterUnset
		? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
		: undefined;

	return (
		<div className={cn("flex flex-col", dimmed && "opacity-40")}>
			<FieldLabel
				name={param.name}
				optional={param.optional}
				defined={param.defined}
				onSetDefined={setDefinedHandler}
			/>
			<div className={cn("mt-1", controlDisabled && "pointer-events-none opacity-40")}>
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
			</div>
		</div>
	);
}
