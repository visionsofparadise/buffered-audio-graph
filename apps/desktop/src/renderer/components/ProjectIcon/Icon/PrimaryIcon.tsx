import type { IconProps } from "../IconProps";

export function PrimaryIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<div
			ref={ref}
			style={{ position: "relative", width: size, height: size, backgroundColor: color, ...style }}
			className={className}
			{...rest}
		>
			<div
				style={{
					position: "absolute",
					top: 0,
					right: 0,
					width: size / 3,
					height: size / 3,
					backgroundColor: "var(--color-accent-primary)",
				}}
			/>
		</div>
	);
}
