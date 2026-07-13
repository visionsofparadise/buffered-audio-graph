import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../DropdownMenu";
import { IconButton } from "../../../IconButton";
import { EllipsisVertical, Power, RotateCcw, Trash2 } from "lucide-react";

export interface NodeMenuActions {
	readonly bypassed: boolean;
	readonly onBypass?: () => void;
	readonly onReset?: () => void;
	readonly onDelete?: () => void;
}

/**
 * The single source of the node-action vocabulary — Bypass/Enable, Reset,
 * Delete Node — with 14px leading icons. Rendered inside both the node header's
 * dots menu (`NodeMenu`) and the right-click node context menu
 * (`GraphContextMenu`) so the two cannot diverge. Both mount it inside a
 * `DropdownMenuContent`, so it emits only the item/separator rows.
 */
export function NodeMenuItems({ bypassed, onBypass, onReset, onDelete }: NodeMenuActions) {
	return (
		<>
			<DropdownMenuItem onSelect={() => onBypass?.()}>
				<Power size={14} strokeWidth={1.5} />
				<span>{bypassed ? "Enable" : "Bypass"}</span>
			</DropdownMenuItem>

			<DropdownMenuItem onSelect={() => onReset?.()}>
				<RotateCcw size={14} strokeWidth={1.5} />
				<span>Reset</span>
			</DropdownMenuItem>

			<DropdownMenuSeparator />

			<DropdownMenuItem onSelect={() => onDelete?.()}>
				<Trash2 size={14} strokeWidth={1.5} />
				<span>Delete Node</span>
			</DropdownMenuItem>
		</>
	);
}

export function NodeMenu(actions: NodeMenuActions) {
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
				<NodeMenuItems {...actions} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
