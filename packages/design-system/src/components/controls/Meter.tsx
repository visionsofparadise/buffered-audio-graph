import { useState, useEffect, useRef } from "react";
import { cn } from "../../cn";

export interface MeterProps {
	readonly level: number;
	readonly height?: number;
	readonly width?: number;
	readonly animated?: boolean;
	readonly className?: string;
}

const METER_GRADIENT = "linear-gradient(to top, var(--color-meter-green), var(--color-meter-yellow))";

export const Meter = ({
	level,
	height = 80,
	width = 4,
	animated = false,
	className,
}: MeterProps) => {
	const [displayLevel, setDisplayLevel] = useState(level);
	const levelRef = useRef(displayLevel);

	useEffect(() => {
		if (!animated) {
			setDisplayLevel(level);

			return;
		}

		levelRef.current = level;
		let frameId: number;
		let lastTime = 0;

		const tick = (time: number) => {
			if (time - lastTime >= 60) {
				lastTime = time;
				setDisplayLevel((prev) => {
					const next = prev + (Math.random() - 0.5) * 0.15;

					return Math.max(0, Math.min(1, next));
				});
			}

			frameId = requestAnimationFrame(tick);
		};

		frameId = requestAnimationFrame(tick);

		return () => cancelAnimationFrame(frameId);
	}, [animated, level]);

	return (
		<div className={cn("relative overflow-hidden bg-surface", className)} style={{ width, height }}>
			<div
				className="absolute inset-0"
				style={{ background: METER_GRADIENT }}
			/>
			<div
				className="absolute top-0 w-full bg-surface"
				style={{ height: `${(1 - displayLevel) * 100}%` }}
			/>
		</div>
	);
};
