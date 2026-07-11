import { Barcode } from "../../Barcode";
import type { IconProps } from "../IconProps";

export function BarcodeIcon({ color, size = 32, className, ref, style, ...rest }: IconProps) {
	return (
		<Barcode
			text="BAG"
			height={size}
			color={color}
			accentColor="var(--color-accent-primary)"
			className={className}
			ref={ref}
			style={style}
			{...rest}
		/>
	);
}
