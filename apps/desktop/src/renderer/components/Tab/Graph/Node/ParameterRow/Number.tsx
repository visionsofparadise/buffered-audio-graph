import { useState, useEffect, useRef } from "react";
import { Knob } from "@buffered-audio/design-system";
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
	const normalize = (raw: number) => (raw - param.min) / range;
	const denormalize = (normalized: number) => param.min + normalized * range;

	const [localValue, setLocalValue] = useState(param.value);
	const draggingRef = useRef(false);

	useEffect(() => {
		if (!draggingRef.current) setLocalValue(param.value);
	}, [param.value]);

	const normalized = normalize(localValue);
	const displayValue = draggingRef.current ? localValue : param.value;

	return (
		<div className={`flex items-center justify-between gap-3 ${dimmed ? "opacity-40" : ""}`}>
			<span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] text-chrome-text-secondary">
				{param.name}
			</span>
			<div className="flex shrink-0 items-center gap-2">
				<span className="font-technical text-[length:var(--text-xs)] tabular-nums text-chrome-text">
					{displayValue}{param.unit ? ` ${param.unit}` : ""}
				</span>
				<Knob
					value={normalized}
					label=""
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
			</div>
		</div>
	);
}
