import type { IconProps } from "../IconProps";
import type { ReactNode } from "react";

export function SvgIcon({
	size = 32,
	className,
	ref,
	style,
	children,
	...rest
}: Omit<IconProps, "color"> & { readonly children: ReactNode }) {
	return (
		<div ref={ref} className={className} style={style} {...rest}>
			<svg width={size} height={size} viewBox="0 0 32 32">
				{children}
			</svg>
		</div>
	);
}
