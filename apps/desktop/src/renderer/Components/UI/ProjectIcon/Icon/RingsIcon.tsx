import { SvgIcon } from "./SvgIcon";
import type { IconProps } from "../IconProps";

export function RingsIcon({ color, ...rest }: IconProps) {
	return (
		<SvgIcon {...rest}>
			<circle cx="16" cy="16" r="14.5" stroke={color} fill="none" strokeWidth="1" />
			<circle cx="16" cy="16" r="10" stroke={color} fill="none" strokeWidth="1" opacity="0.6" />
			<circle cx="16" cy="16" r="5.5" stroke="var(--color-accent-primary)" fill="none" strokeWidth="1" />
		</SvgIcon>
	);
}
