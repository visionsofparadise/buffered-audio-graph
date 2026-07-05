import { useState, useEffect, useRef } from "react";
import { Knob } from "@buffered-audio/design-system";
import { cn } from "../../../../../utils/cn";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";

export interface NumberParameter {
	readonly kind: "number";
	readonly name: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly unit: string;
}

function snapToStep(value: number, step: number): number {
	if (step <= 0) return value;

	return Math.round(value / step) * step;
}

/** Format a number param for its on-node readout — step decides precision. */
function formatParamValue(value: number, step: number): string {
	const decimals = (step.toString().split(".")[1] ?? "").length;

	return value.toFixed(decimals);
}

export function NumberRow({
	param,
	dimmed,
	disabled,
	onParameterChange,
}: {
	readonly param: NumberParameter;
	readonly dimmed?: boolean;
	readonly disabled?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
	const range = param.max - param.min;
	const normalize = (raw: number) => (range === 0 ? 0 : (raw - param.min) / range);
	const denormalize = (normalized: number) => param.min + normalized * range;

	const [localValue, setLocalValue] = useState(param.value);
	const draggingRef = useRef(false);

	useEffect(() => {
		if (!draggingRef.current) setLocalValue(param.value);
	}, [param.value]);

	const normalized = normalize(localValue);

	return (
		<div className={cn("flex items-center justify-between gap-3", dimmed && "opacity-40")}>
			<span className={paramLabelClass(true)}>{humanizeFieldName(param.name)}</span>
			<div className="flex shrink-0 flex-col items-center gap-1">
				<span className="type-value w-12 text-center text-label text-text-secondary">
					{formatParamValue(localValue, param.step)}
				</span>
				<Knob
					value={normalized}
					size={32}
					hideValue
					disabled={disabled}
					onChange={(norm: number) => {
						draggingRef.current = true;
						setLocalValue(snapToStep(denormalize(norm), param.step));
					}}
					onChangeEnd={(norm: number) => {
						draggingRef.current = false;
						const committed = snapToStep(denormalize(norm), param.step);

						setLocalValue(committed);
						onParameterChange?.(param.name, committed);
					}}
				/>
				{param.unit !== "" && (
					<span className="type-label text-text-secondary">{param.unit}</span>
				)}
			</div>
		</div>
	);
}
