import { cn } from "../../utils/cn";
import { encodeToElements } from "./utils/barcodeEncoding";
import type { ComponentPropsWithRef } from "react";

export interface BarcodeProps extends Omit<ComponentPropsWithRef<"div">, "color"> {
	readonly text: string;
	readonly height?: number;
	readonly narrow?: number;
	readonly wide?: number;
	readonly gap?: number;
	readonly color?: string;
	readonly accentColor?: string;
}

export function Barcode({
	text,
	height = 48,
	narrow = 1,
	wide = 3,
	gap = 0,
	color = "var(--color-text-primary)",
	accentColor,
	className,
	style,
	ref,
	...rest
}: BarcodeProps) {
	const elements = encodeToElements(text);

	return (
		<div ref={ref} className={cn("flex items-end", className)} style={{ height, gap, ...style }} {...rest}>
			{elements.map((element, ix) => {
				const isWide = element === "w";
				const isVisible = ix % 2 === 0;

				return (
					<div
						key={`bar-${ix}`}
						style={{
							width: isWide ? wide : narrow,
							height: "100%",
							backgroundColor: isVisible ? (accentColor && isWide ? accentColor : color) : "transparent",
						}}
					/>
				);
			})}
		</div>
	);
}
