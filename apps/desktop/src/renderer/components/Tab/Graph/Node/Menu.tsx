import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
} from "@buffered-audio/design-system";
import { Download, EllipsisVertical, Square, Trash2 } from "lucide-react";

export function NodeMenu({ isSource, onRender, onAbort, onDelete }: {
	readonly isSource: boolean;
	readonly onRender?: () => void;
	readonly onAbort?: () => void;
	readonly onDelete?: () => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<IconButton
					icon={EllipsisVertical}
					label="Node menu"
					variant="ghost"
					size="sm"
					className="text-surface hover:bg-surface/20 hover:text-surface"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{!isSource && (
					<DropdownMenuItem onSelect={() => onRender?.()}>
						<Download size={14} strokeWidth={1.5} className="shrink-0" />
						<span>Render</span>
					</DropdownMenuItem>
				)}

				{!isSource && (
					<DropdownMenuItem onSelect={() => onAbort?.()}>
						<Square size={14} strokeWidth={1.5} className="shrink-0" />
						<span>Abort</span>
					</DropdownMenuItem>
				)}

				{!isSource && <DropdownMenuSeparator />}

				<DropdownMenuItem
					className="text-accent-primary"
					onSelect={() => onDelete?.()}
				>
					<Trash2 size={14} strokeWidth={1.5} className="shrink-0" />
					<span>Delete</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
