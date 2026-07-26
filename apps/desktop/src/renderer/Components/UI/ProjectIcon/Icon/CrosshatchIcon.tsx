import type { IconProps } from "../IconProps";

export function CrosshatchIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				{Array.from({ length: 6 }, (_, ix) => (
					<line key={`h${ix}`} x1={0} y1={ix * 7} x2={32} y2={ix * 7} stroke={color} strokeWidth="1" opacity={0.6} />
				))}
				{Array.from({ length: 6 }, (_, ix) => (
					<line key={`v${ix}`} x1={ix * 7} y1={0} x2={ix * 7} y2={32} stroke={ix === 3 ? "var(--color-accent-primary)" : color} strokeWidth={ix === 3 ? 2 : 1} opacity={ix === 3 ? 1 : 0.6} />
				))}
			</svg>
		</div>
	);
}
