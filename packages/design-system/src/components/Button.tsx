import type { LucideIcon } from "lucide-react";
import { cn } from "../cn";

export interface ButtonProps extends React.ComponentPropsWithRef<"button"> {
	readonly variant?: "default" | "outline" | "ghost";
	readonly size?: "sm" | "md" | "lg";
	/** Optional leading Lucide icon, rendered before the label. */
	readonly icon?: LucideIcon;
}

const sizeStyles = {
	sm: "px-2.5 py-1 text-label",
	md: "px-4 py-2 text-xs",
	lg: "px-5 py-2.5 text-body",
};

const iconSizes = {
	sm: 14,
	md: 16,
	lg: 18,
};

const variantStyles = {
	default: "bg-text-primary text-surface",
	outline: "bg-elevated text-text-primary",
	ghost: "text-text-secondary hover:text-text-primary",
};

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
