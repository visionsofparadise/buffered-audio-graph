import { Toggle } from "@buffered-audio/design-system";
import { cn } from "../../../../../utils/cn";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";

export interface BooleanParameter {
	readonly kind: "boolean";
	readonly name: string;
	readonly value: boolean;
}

export function BooleanRow({
	param,
	dimmed,
	onParameterChange,
}: {
	readonly param: BooleanParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
	return (
		<div className={cn("flex items-center justify-between gap-3", dimmed && "opacity-40")}>
			<span className={paramLabelClass(true)}>{humanizeFieldName(param.name)}</span>
			<div className="shrink-0">
				<Toggle
					value={param.value}
					label={param.value ? "ON" : "OFF"}
					onChange={onParameterChange ? (toggled) => onParameterChange(param.name, toggled) : undefined}
				/>
			</div>
		</div>
	);
}
