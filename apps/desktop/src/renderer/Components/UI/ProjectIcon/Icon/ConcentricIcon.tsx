import { SvgIcon } from "./SvgIcon";
import type { IconProps } from "../IconProps";

export function ConcentricIcon({ color, ...rest }: IconProps) {
	return (
		<SvgIcon {...rest}>
			<rect x="0.5" y="0.5" width="31" height="31" stroke={color} fill="none" strokeWidth="1" />
			<rect x="6.5" y="6.5" width="19" height="19" stroke={color} fill="none" strokeWidth="1" />
			<rect
				x="12.5"
				y="12.5"
				width="7"
				height="7"
				stroke="var(--color-accent-primary)"
				fill="none"
				strokeWidth="1"
			/>
		</SvgIcon>
	);
}
