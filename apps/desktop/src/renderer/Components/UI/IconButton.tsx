import type { LucideIcon } from "lucide-react";
import { cn } from "../../utils/cn";
import { iconSizes, sizeStyles, variantStyles } from "./utils/iconButtonStyles";

export interface IconButtonProps extends Omit<React.ComponentPropsWithRef<"button">, "children" | "aria-label"> {
	readonly icon: LucideIcon;
	readonly label: string;
	readonly variant?: "default" | "outline" | "ghost";
	readonly size?: "sm" | "md" | "lg";
}

export function IconButton({
	icon: Icon,
	label,
	variant = "ghost",
	size = "md",
	className,
	type = "button",
	...props
}: IconButtonProps) {
	return (
		<button
			type={type}
			aria-label={label}
			{...props}
			className={cn(
				"inline-flex aspect-square items-center justify-center rounded-none",
				sizeStyles[size],
				variantStyles[variant],
				props.disabled && "text-dimmed cursor-not-allowed",
				className,
			)}
		>
			<Icon size={iconSizes[size]} strokeWidth={1.5} />
		</button>
	);
}
