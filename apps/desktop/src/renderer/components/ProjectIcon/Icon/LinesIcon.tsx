import { cn } from "../../../utils/cn";
import type { IconProps } from "../IconProps";

export function LinesIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			className={cn("flex flex-col justify-between", className)}
			style={{ width: size, height: size, ...style }}
			{...rest}
		>
			{Array.from({ length: 8 }, (_, ix) => (
				<div
					key={`line-${ix}`}
					style={{
						width: `${60 + ((ix * 37) % 41)}%`,
						height: ix === 0 ? 2 : 1,
						backgroundColor: ix === 0 ? "var(--color-accent-primary)" : color,
						opacity: ix % 2 === 0 ? 1 : 0.4,
					}}
				/>
			))}
		</div>
	);
}
