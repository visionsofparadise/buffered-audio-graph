import { Input } from "../../../../Input";
import { cn } from "../../../../../utils/cn";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";

export interface StringParameter {
	readonly kind: "string";
	readonly name: string;
	readonly value: string;
}

export function StringRow({
	param,
	dimmed,
	onParameterChange,
}: {
	readonly param: StringParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
	return (
		<div className={cn("flex flex-col", dimmed && "opacity-40")}>
			<span className={cn(paramLabelClass(true), "mb-1")}>{humanizeFieldName(param.name)}</span>
			<Input
				type="text"
				key={param.value}
				defaultValue={param.value}
				onChange={onParameterChange ? (next) => onParameterChange(param.name, next) : undefined}
				className="w-full"
			/>
		</div>
	);
}
