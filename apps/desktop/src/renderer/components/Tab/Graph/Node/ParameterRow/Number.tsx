import { useState, useEffect, useRef } from "react";
import { Knob } from "../../../../Knob";
import { cn } from "../../../../../utils/cn";
import { FieldLabel } from "./FieldLabel";

export interface NumberParameter {
	readonly kind: "number";
	readonly name: string;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly description: string;
	readonly optional: boolean;
	readonly defined: boolean;
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
	onParameterUnset,
}: {
	readonly param: NumberParameter;
	readonly dimmed?: boolean;
	readonly disabled?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterUnset?: (name: string) => void;
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
	const controlDisabled = (disabled ?? false) || (param.optional && !param.defined);
	const setDefinedHandler = onParameterChange || onParameterUnset
		? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
		: undefined;

	return (
		<div
			className={cn("flex items-center justify-between gap-3", dimmed && "opacity-40")}
			title={param.description || undefined}
		>
			<FieldLabel
				name={param.name}
				optional={param.optional}
				defined={param.defined}
				onSetDefined={setDefinedHandler}
			/>
			<div className={cn("flex shrink-0 flex-col items-center gap-1", controlDisabled && "pointer-events-none opacity-40")}>
				<span className="type-value w-12 text-center text-label text-text-secondary">
					{formatParamValue(localValue, param.step)}
				</span>
				<Knob
					value={normalized}
					size={32}
					hideValue
					disabled={controlDisabled}
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
			</div>
		</div>
	);
}
