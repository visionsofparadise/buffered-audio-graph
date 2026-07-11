import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../utils/cn";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

export function DropdownMenuContent({
	className,
	sideOffset = 4,
	collisionPadding = 8,
	...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.Content
				sideOffset={sideOffset}
				collisionPadding={collisionPadding}
				className={cn(
					"z-50 flex min-w-44 flex-col rounded-xs bg-elevated py-1 outline-none",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
}

export function DropdownMenuItem({
	className,
	...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>) {
	return (
		<DropdownMenuPrimitive.Item
			className={cn(
				"type-label flex cursor-pointer items-center gap-2 px-3 py-2 text-body text-left text-text-primary outline-none",
				"data-[highlighted]:bg-text-primary data-[highlighted]:text-surface",
				"data-[disabled]:cursor-default data-[disabled]:text-dimmed",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuLabel({
	className,
	...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>) {
	return (
		<DropdownMenuPrimitive.Label
			className={cn(
				"type-label px-3 py-1.5 text-xs text-text-secondary",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({
	className,
	...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) {
	return (
		<DropdownMenuPrimitive.Separator
			className={cn("mx-2 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

export function DropdownMenuSubTrigger({
	className,
	...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>) {
	return (
		<DropdownMenuPrimitive.SubTrigger
			className={cn(
				"type-label flex cursor-pointer items-center gap-2 px-3 py-2 text-body text-left text-text-primary outline-none",
				"data-[highlighted]:bg-text-primary data-[highlighted]:text-surface",
				"data-[state=open]:bg-text-primary data-[state=open]:text-surface",
				"data-[disabled]:cursor-default data-[disabled]:text-dimmed",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuSubContent({
	className,
	...props
}: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>) {
	return (
		<DropdownMenuPrimitive.Portal>
			<DropdownMenuPrimitive.SubContent
				className={cn(
					"z-50 flex min-w-44 flex-col rounded-xs bg-elevated py-1 outline-none",
					className,
				)}
				{...props}
			/>
		</DropdownMenuPrimitive.Portal>
	);
}
