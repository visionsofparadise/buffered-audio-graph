import { SvgIcon } from "./SvgIcon";
import type { IconProps } from "../IconProps";

export function QuarterIcon({ color, ...rest }: IconProps) {
	return (
		<SvgIcon {...rest}>
			<rect x="0.5" y="0.5" width="31" height="31" stroke={color} fill="none" strokeWidth="1" />
			<rect x="0" y="16" width="16" height="16" fill="var(--color-accent-primary)" />
		</SvgIcon>
	);
}
