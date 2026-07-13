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
	const [editText, setEditText] = useState<string | null>(null);
	const draggingRef = useRef(false);

	useEffect(() => {
		if (!draggingRef.current) setLocalValue(param.value);
	}, [param.value]);

	const normalized = normalize(localValue);
	const controlDisabled = (disabled ?? false) || (param.optional && !param.defined);
	const setDefinedHandler = onParameterChange || onParameterUnset
		? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
		: undefined;

	const beginEdit = (): void => {
		if (controlDisabled) return;

		setEditText(formatParamValue(localValue, param.step));
	};

	const commitEdit = (): void => {
		const raw = editText;

		setEditText(null);

		if (raw === null) return;

		const parsed = Number(raw);

		if (raw.trim() === "" || !Number.isFinite(parsed)) return;

		const clamped = Math.max(param.min, Math.min(param.max, snapToStep(parsed, param.step)));

		setLocalValue(clamped);
		onParameterChange?.(param.name, clamped);
	};

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
			<div
				className={cn("flex shrink-0 flex-col items-center gap-1", controlDisabled && "pointer-events-none opacity-40")}
				onDoubleClick={beginEdit}
			>
				{editText !== null ? (
					<input
						type="number"
						autoFocus
						value={editText}
						min={param.min}
						max={param.max}
						step={param.step}
						onChange={(event) => setEditText(event.target.value)}
						onBlur={commitEdit}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								commitEdit();
							} else if (event.key === "Escape") {
								event.preventDefault();
								setEditText(null);
							}
						}}
						className="h-8 w-16 rounded-xs bg-surface px-2 text-center text-label tabular-nums text-text-primary outline-none"
					/>
				) : (
					<>
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
					</>
				)}
			</div>
		</div>
	);
}
