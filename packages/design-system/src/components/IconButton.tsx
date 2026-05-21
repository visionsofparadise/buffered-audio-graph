import type { LucideIcon } from "lucide-react";
import { cn } from "../cn";

export interface IconButtonProps extends Omit<React.ComponentPropsWithRef<"button">, "children" | "aria-label"> {
	readonly icon: LucideIcon;
	readonly label: string;
	readonly variant?: "default" | "outline" | "ghost";
	readonly size?: "sm" | "md" | "lg";
}

const sizeStyles = {
	sm: "p-1.5 text-label",
	md: "p-2.5 text-xs",
	lg: "p-3 text-body",
};

const iconSizes = {
	sm: 14,
	md: 16,
	lg: 20,
};

const variantStyles = {
	default: "bg-text-primary text-surface",
	outline: "bg-elevated text-text-primary",
	ghost: "text-text-secondary hover:text-text-primary",
};

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
