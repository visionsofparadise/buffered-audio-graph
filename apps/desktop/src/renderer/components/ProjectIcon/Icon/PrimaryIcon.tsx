import type { IconProps } from "../IconProps";

export function PrimaryIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			style={{ width: size, height: size, backgroundColor: color, ...style }}
			className={className}
			{...rest}
		/>
	);
}
