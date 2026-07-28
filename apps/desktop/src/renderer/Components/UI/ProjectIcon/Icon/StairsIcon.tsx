import { SvgIcon } from "./SvgIcon";
import type { IconProps } from "../IconProps";

export function StairsIcon({ color, ...rest }: IconProps) {
	return (
		<SvgIcon {...rest}>
			<rect x="0" y="0" width="8" height="32" fill={color} opacity="0.25" />
			<rect x="8" y="8" width="8" height="24" fill={color} opacity="0.45" />
			<rect x="16" y="16" width="8" height="16" fill={color} opacity="0.65" />
			<rect x="24" y="24" width="8" height="8" fill="var(--color-accent-primary)" />
		</SvgIcon>
	);
}
