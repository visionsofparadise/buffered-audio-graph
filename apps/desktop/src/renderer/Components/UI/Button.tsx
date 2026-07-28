import { cn } from "../../utils/cn";
import { iconSizes, sizeStyles, variantStyles } from "./utils/buttonStyles";
import type { LucideIcon } from "lucide-react";

export interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
	readonly variant?: "default" | "outline" | "ghost";
	readonly size?: "sm" | "md" | "lg";
	readonly icon?: LucideIcon;
}

export function Button({
	variant = "default",
	size = "md",
	icon: Icon,
	className,
	children,
	type = "button",
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			{...props}
			className={cn(
				"type-label inline-flex items-center justify-center rounded-none",
				Icon && "gap-2",
				sizeStyles[size],
				variantStyles[variant],
				props.disabled && "text-dimmed cursor-not-allowed",
				className,
			)}
		>
			{Icon && <Icon size={iconSizes[size]} strokeWidth={1.5} aria-hidden="true" />}
			{children}
		</button>
	);
}
