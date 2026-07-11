import { cn } from "../../../utils/cn";
import type { IconProps } from "../IconProps";

export function DotGridIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			className={cn("grid", className)}
			style={{
				width: size,
				height: size,
				gridTemplateColumns: "repeat(5, 1fr)",
				gridTemplateRows: "repeat(5, 1fr)",
				placeItems: "center",
				...style,
			}}
			{...rest}
		>
			{Array.from({ length: 25 }, (_, ix) => (
				<div
					key={`dot-${ix}`}
					style={{
						width: 3,
						height: 3,
						borderRadius: "50%",
						backgroundColor: ix === 12 ? "var(--color-accent-primary)" : color,
						opacity: ix === 12 || ix % 5 === 0 || ix < 5 || ix >= 20 || ix % 5 === 4 ? 1 : 0.4,
					}}
				/>
			))}
		</div>
	);
}
