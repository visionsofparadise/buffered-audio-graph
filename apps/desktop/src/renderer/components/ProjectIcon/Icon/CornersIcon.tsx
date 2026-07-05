import type { IconProps } from "../IconProps";

export function CornersIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				<rect x="0" y="0" width="8" height="8" fill={color} />
				<rect x="24" y="0" width="8" height="8" fill={color} />
				<rect x="0" y="24" width="8" height="8" fill={color} />
				<rect x="24" y="24" width="8" height="8" fill={color} />
				<rect x="12" y="12" width="8" height="8" fill={color} opacity="0.4" />
			</svg>
		</div>
	);
}
