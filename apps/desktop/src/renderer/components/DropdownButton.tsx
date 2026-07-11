import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./DropdownMenu";

export type MenuItem =
	| {
		readonly kind: "action";
		readonly label: string;
		readonly icon?: LucideIcon;
		readonly shortcut?: string;
		readonly color?: string;
		readonly disabled?: boolean;
		readonly onClick?: () => void;
	}
	| {
		readonly kind: "separator";
	};

export interface DropdownButtonProps {
	readonly trigger: ReactNode;
	readonly items: ReadonlyArray<MenuItem>;
	readonly align?: "left" | "right";
}

/**
 * DropdownButton — a data-driven menu built on the DropdownMenu parts.
 *
 * Takes an array of `MenuItem`s and renders them; the menu surface, item, and
 * separator styling all come from `DropdownMenu*` so there is one source of
 * truth for the menu look.
 */
export function DropdownButton({ trigger, items, align = "left" }: DropdownButtonProps) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align={align === "right" ? "end" : "start"}>
				{items.map((item, index) => {
					if (item.kind === "separator") {
						return (
							<DropdownMenuSeparator key={`separator-${String(index)}`} />
						);
					}

					const ItemIcon = item.icon;

					return (
						<DropdownMenuItem
							key={`${item.label}-${String(index)}`}
							disabled={item.disabled}
							onSelect={item.onClick ? () => item.onClick?.() : undefined}
							className={item.color}
						>
							{ItemIcon && (
								<ItemIcon size={14} strokeWidth={1.5} aria-hidden="true" />
							)}
							<span className="flex-1">{item.label}</span>
							{item.shortcut && (
								<span className="type-label ml-4 text-body text-text-secondary">
									{item.shortcut}
								</span>
							)}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
