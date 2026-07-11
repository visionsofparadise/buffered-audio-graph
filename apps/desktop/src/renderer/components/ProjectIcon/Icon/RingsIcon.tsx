import type { IconProps } from "../IconProps";

export function RingsIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<circle cx="16" cy="16" r="14.5" stroke={color} fill="none" strokeWidth="1" />
				<circle cx="16" cy="16" r="10" stroke={color} fill="none" strokeWidth="1" opacity="0.6" />
				<circle cx="16" cy="16" r="5.5" stroke="var(--color-accent-primary)" fill="none" strokeWidth="1" />
			</svg>
		</div>
	);
}
