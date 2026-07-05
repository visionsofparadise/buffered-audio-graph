import { ButtonSelection, Select } from "@buffered-audio/design-system";
import { cn } from "../../../../../utils/cn";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";

export interface EnumParameter {
	readonly kind: "enum";
	readonly name: string;
	readonly value: string;
	readonly options: ReadonlyArray<string>;
}

export function EnumRow({
	param,
	dimmed,
	onParameterChange,
}: {
	readonly param: EnumParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
	const useButtons = param.options.every((opt) => opt.length <= 10);

	return (
		<div className={cn("flex flex-col", dimmed && "opacity-40")}>
			<span className={cn(paramLabelClass(true), "mb-1")}>{humanizeFieldName(param.name)}</span>
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
	);
}
