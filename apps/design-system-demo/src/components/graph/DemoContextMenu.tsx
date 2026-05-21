import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { cn } from "@buffered-audio/design-system";

/**
 * Carried over from the previous DemoContextMenu — these match the actions
 * the graph workspace exposes on right-click. Wired to no-op handlers in the
 * demo; real callsites can override via the `items` prop.
 */
export interface DemoContextMenuItem {
	readonly kind: "action";
	readonly label: string;
	readonly onClick?: () => void;
	readonly disabled?: boolean;
}

export interface DemoContextMenuSeparator {
	readonly kind: "separator";
}

export type DemoContextMenuEntry = DemoContextMenuItem | DemoContextMenuSeparator;

const DEFAULT_ITEMS: ReadonlyArray<DemoContextMenuEntry> = [
	{ kind: "action", label: "Add Node" },
	{ kind: "action", label: "Delete Node" },
	{ kind: "separator" },
	{ kind: "action", label: "Bypass / Enable" },
	{ kind: "action", label: "Reset" },
	{ kind: "separator" },
	{ kind: "action", label: "Render" },
];

interface DemoContextMenuProps {
	readonly children: ReactNode;
	readonly items?: ReadonlyArray<DemoContextMenuEntry>;
}

/**
 * Wrap a region of the graph canvas in this component to make right-click
 * open the demo menu at the click position. Built on Radix ContextMenu so
 * positioning, scroll-lock, keyboard navigation, and outside-click dismissal
 * are handled by the library.
 */
export function DemoContextMenu({ children, items = DEFAULT_ITEMS }: DemoContextMenuProps) {
	return (
		<ContextMenuPrimitive.Root>
			<ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
			<ContextMenuPrimitive.Portal>
				<ContextMenuPrimitive.Content
					collisionPadding={8}
					className={cn(
						"z-50 flex min-w-44 flex-col rounded-xs bg-elevated py-1 outline-none",
					)}
				>
					{items.map((item, index) => {
						if (item.kind === "separator") {
							return (
								<ContextMenuPrimitive.Separator
									key={`separator-${String(index)}`}
									className="mx-2 my-1 h-px bg-border"
								/>
							);
						}

						return (
							<ContextMenuPrimitive.Item
								key={`${item.label}-${String(index)}`}
								disabled={item.disabled}
								onSelect={item.onClick ? () => item.onClick?.() : undefined}
								className={cn(
									"type-label flex cursor-pointer items-center gap-2 px-3 py-2 text-body text-left outline-none",
									"text-text-primary",
									"data-[highlighted]:bg-text-primary data-[highlighted]:text-surface",
									"data-[disabled]:cursor-default data-[disabled]:text-dimmed",
								)}
							>
								{item.label}
							</ContextMenuPrimitive.Item>
						);
					})}
				</ContextMenuPrimitive.Content>
			</ContextMenuPrimitive.Portal>
		</ContextMenuPrimitive.Root>
	);
}
