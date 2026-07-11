import type { IconProps } from "../IconProps";

export function DiagonalIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				{Array.from({ length: 8 }, (_, ix) => (
					<line
						key={`a${ix}`}
						x1={ix * 5}
						y1={0}
						x2={0}
						y2={ix * 5}
						stroke={ix === 4 ? "var(--color-accent-primary)" : color}
						strokeWidth={ix === 4 ? 2 : 1}
						opacity={ix % 2 === 0 ? 1 : 0.4}
					/>
				))}
				{Array.from({ length: 8 }, (_, ix) => (
					<line
						key={`b${ix}`}
						x1={32}
						y1={ix * 5 + 2}
						x2={ix * 5 + 2}
						y2={32}
						stroke={color}
						strokeWidth="1"
						opacity={ix % 2 === 0 ? 1 : 0.4}
					/>
				))}
			</svg>
		</div>
	);
}
