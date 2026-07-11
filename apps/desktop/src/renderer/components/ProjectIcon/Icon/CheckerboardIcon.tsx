import { cn } from "../../../utils/cn";
import type { IconProps } from "../IconProps";

export function CheckerboardIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	const cellSize = size / 4;

	return (
		<div
			ref={ref}
			className={cn("grid", className)}
			style={{
				width: size,
				height: size,
				gridTemplateColumns: `repeat(4, ${cellSize}px)`,
				gridTemplateRows: `repeat(4, ${cellSize}px)`,
				...style,
			}}
			{...rest}
		>
			{Array.from({ length: 16 }, (_, ix) => (
				<div
					key={`cell-${ix}`}
					style={{
						backgroundColor:
							ix === 10 ? "var(--color-accent-primary)" : (Math.floor(ix / 4) + (ix % 4)) % 2 === 0 ? color : "transparent",
					}}
				/>
			))}
		</div>
	);
}
