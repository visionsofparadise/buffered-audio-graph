import { Barcode } from "@buffered-audio/design-system";
import type { IconProps } from "../IconProps";

export function BarcodeIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<Barcode
			text="BAG"
			height={size}
			color={color}
			className={className}
			ref={ref}
			style={style}
			{...rest}
		/>
	);
}
