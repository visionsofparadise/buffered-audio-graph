import { useState, useCallback, useRef } from "react";
import { cn } from "../utils/cn";

export interface KnobProps {
	readonly value: number;
	readonly label?: string;
	readonly size?: number;
	readonly onChange?: (v: number) => void;
	readonly onChangeEnd?: (v: number) => void;
	readonly className?: string;
	readonly hideValue?: boolean;
	readonly disabled?: boolean;
}

export const Knob = ({
	value,
	label,
	size = 32,
	onChange,
	onChangeEnd,
	className,
	hideValue,
	disabled,
}: KnobProps) => {
	const [dragging, setDragging] = useState(false);
	const startY = useRef(0);
	const startValue = useRef(0);
	const currentValue = useRef(value);

	const radius = (size - 4) / 2;
	const cx = size / 2;
	const cy = size / 2;
	const startAngle = 135;
	const totalSweep = 270;
	const valueSweep = totalSweep * value;

	const polarToCartesian = (angle: number) => {
		const rad = (angle * Math.PI) / 180;

		return {
			x: cx + radius * Math.cos(rad),
			y: cy + radius * Math.sin(rad),
		};
	};

	const arcPath = (start: number, sweep: number) => {
		if (sweep <= 0) return "";
		const end = start + sweep;
		const sp = polarToCartesian(start);
		const ep = polarToCartesian(end);
		const largeArc = sweep > 180 ? 1 : 0;

		return `M ${sp.x} ${sp.y} A ${radius} ${radius} 0 ${largeArc} 1 ${ep.x} ${ep.y}`;
	};

	const onPointerDown = useCallback(
		(ev: React.PointerEvent) => {
			if (!onChange || disabled) return;
			setDragging(true);
			(ev.target as Element).setPointerCapture(ev.pointerId);
			startY.current = ev.clientY;
			startValue.current = value;
		},
		[onChange, disabled, value],
	);

	const onPointerMove = useCallback(
		(ev: React.PointerEvent) => {
			if (!dragging || !onChange) return;
			const delta = (startY.current - ev.clientY) / 150;
			const clamped = Math.max(0, Math.min(1, startValue.current + delta));

			currentValue.current = clamped;
			onChange(clamped);
		},
		[dragging, onChange],
	);

	const onPointerUp = useCallback(() => {
		setDragging(false);
		onChangeEnd?.(currentValue.current);
	}, [onChangeEnd]);

	return (
		<div className={cn("flex flex-col items-center gap-1", className)}>
			{!hideValue && (
				<span className="type-value w-9 text-center text-label text-text-secondary">
					{Math.round(value * 100)}
				</span>
			)}
			<svg
				width={size}
				height={size}
				style={{ display: "block", width: size, height: size }}
				className={onChange && !disabled ? "cursor-pointer" : undefined}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
			>
				<path
					d={arcPath(startAngle, totalSweep)}
					fill="none"
					style={{ stroke: "var(--color-border)", strokeWidth: 3, strokeLinecap: "round" }}
				/>
				{valueSweep > 0 && (
					<path
						d={arcPath(startAngle, valueSweep)}
						fill="none"
						style={{ stroke: "var(--color-accent-primary)", strokeWidth: 3, strokeLinecap: "round" }}
					/>
				)}
			</svg>
			{label && (
				<span className="type-label text-text-secondary">{label}</span>
			)}
		</div>
	);
};
