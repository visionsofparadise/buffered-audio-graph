import type { ComponentPropsWithRef } from "react";
import { cn } from "@buffered-audio/design-system";

export interface BarcodeProps extends Omit<ComponentPropsWithRef<"div">, "color"> {
	readonly widths?: Array<number>;
	readonly height?: number;
	readonly gap?: number;
	readonly color?: string;
}

const DEFAULT_WIDTHS = [
	3, 1, 2, 1, 4, 1, 1, 3, 1, 2, 1, 1, 3, 2, 1, 1, 4, 1, 2, 1, 3, 1, 1, 2, 1,
	4, 1, 1, 3, 1, 2, 1, 1, 2, 3, 1, 1, 4, 1, 2, 1, 3, 1, 1, 2, 1, 1, 3, 2, 1,
];

/**
 * Barcode — a row of alternating filled / transparent bars. Copied from
 * Resequence's design-system `Barcode` component. Decorative.
 */
export function Barcode({
	widths = DEFAULT_WIDTHS,
	height = 48,
	gap = 1,
	color = "var(--color-text-primary)",
	className,
	style,
	ref,
	...rest
}: BarcodeProps) {
	return (
		<div
			ref={ref}
			className={cn("flex items-end", className)}
			style={{ height, gap, ...style }}
			{...rest}
		>
			{widths.map((barWidth, ix) => (
				<div
					key={`bar-${ix}`}
					style={{
						width: barWidth,
						height: "100%",
						backgroundColor: ix % 2 === 0 ? color : "transparent",
					}}
				/>
			))}
		</div>
	);
}
