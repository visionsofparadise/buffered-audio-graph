import {
	Close,
	Content,
	Description,
	Overlay,
	Portal,
	Root,
	Title,
	Trigger,
	type DialogContentProps,
	type DialogDescriptionProps,
	type DialogOverlayProps,
	type DialogTitleProps,
} from "@radix-ui/react-dialog";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../utils/cn";

export const Dialog = Root;
export const DialogTrigger = Trigger;
export const DialogClose = Close;
export const DialogPortal = Portal;

export function DialogOverlay({ className, ...props }: DialogOverlayProps) {
	return (
		<Overlay
			className={cn("fixed inset-0 z-50 bg-black/60", className)}
			{...props}
		/>
	);
}

export function DialogContent({ className, children, ...props }: DialogContentProps) {
	return (
		<Portal>
			<DialogOverlay />
			<Content
				className={cn(
					"fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xs bg-elevated shadow-[0_8px_24px_rgba(0,0,0,0.4)] outline-none",
					className,
				)}
				{...props}
			>
				{children}
			</Content>
		</Portal>
	);
}

export function DialogHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn("flex items-center justify-between px-6 py-4", className)}
			{...props}
		/>
	);
}

export function DialogFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn("flex items-center justify-end px-6 py-4", className)}
			{...props}
		/>
	);
}

export function DialogTitle({ className, ...props }: DialogTitleProps) {
	return (
		<Title
			className={cn("type-label text-body text-text-primary", className)}
			{...props}
		/>
	);
}

export function DialogDescription({ className, ...props }: DialogDescriptionProps) {
	return (
		<Description
			className={cn("text-body text-text-secondary", className)}
			{...props}
		/>
	);
}
