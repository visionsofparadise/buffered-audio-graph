import { Input } from "../../../../Input";
import { cn } from "../../../../../utils/cn";
import { FieldLabel } from "./FieldLabel";

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
				<Input
					type="text"
					key={param.value}
					defaultValue={param.value}
					onChange={onParameterChange ? (next) => onParameterChange(param.name, next) : undefined}
					className="w-full"
				/>
			</div>
		</div>
	);
}
