import { SvgIcon } from "./SvgIcon";
import type { IconProps } from "../IconProps";

export function DotCircleIcon({ color, ...rest }: IconProps) {
	return (
		<SvgIcon {...rest}>
			<circle cx="16" cy="16" r="14.5" stroke={color} fill="none" strokeWidth="1" />
			<circle cx="16" cy="16" r="3" fill="var(--color-accent-primary)" />
		</SvgIcon>
	);
}
