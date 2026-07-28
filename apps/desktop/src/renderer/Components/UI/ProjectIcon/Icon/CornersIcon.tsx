import { SvgIcon } from "./SvgIcon";
import type { IconProps } from "../IconProps";

export function CornersIcon({ color, ...rest }: IconProps) {
	return (
		<SvgIcon {...rest}>
			<rect x="0" y="0" width="8" height="8" fill={color} />
			<rect x="24" y="0" width="8" height="8" fill={color} />
			<rect x="0" y="24" width="8" height="8" fill={color} />
			<rect x="24" y="24" width="8" height="8" fill={color} />
			<rect x="12" y="12" width="8" height="8" fill="var(--color-accent-primary)" />
		</SvgIcon>
	);
}
