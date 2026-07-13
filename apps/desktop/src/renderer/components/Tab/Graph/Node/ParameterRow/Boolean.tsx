import { Toggle } from "../../../../Toggle";
import { cn } from "../../../../../utils/cn";
import { FieldLabel } from "./FieldLabel";

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
	const controlDisabled = param.optional && !param.defined;
	const setDefinedHandler = onParameterChange || onParameterUnset
		? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
		: undefined;

	return (
		<div className={cn("flex items-center justify-between gap-3", dimmed && "opacity-40")}>
			<FieldLabel
				name={param.name}
				optional={param.optional}
				defined={param.defined}
				onSetDefined={setDefinedHandler}
			/>
			<div className={cn("shrink-0", controlDisabled && "pointer-events-none opacity-40")}>
				<Toggle
					value={param.value}
					label={param.value ? "ON" : "OFF"}
					onChange={onParameterChange ? (toggled) => onParameterChange(param.name, toggled) : undefined}
				/>
			</div>
		</div>
	);
}
