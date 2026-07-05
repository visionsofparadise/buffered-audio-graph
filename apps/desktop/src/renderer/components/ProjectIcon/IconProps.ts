import type { ComponentPropsWithRef } from "react";

export interface IconProps extends Omit<ComponentPropsWithRef<"div">, "color"> {
	readonly color: string;
	readonly size?: number;
}
