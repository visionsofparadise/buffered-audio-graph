import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../DropdownMenu";
import { IconButton } from "../../../IconButton";
import { EllipsisVertical } from "lucide-react";

export interface NodeMenuActions {
	readonly isSource: boolean;
	readonly bypassed: boolean;
	readonly onBypass?: () => void;
	readonly onReset?: () => void;
	readonly onRender?: () => void;
	readonly onAbort?: () => void;
	readonly onDelete?: () => void;
}

/**
 * The single source of the node-action vocabulary — Bypass/Enable, Reset,
 * Render/Abort (hidden for source nodes), Delete Node. Rendered inside both the
 * node header's dots menu (`NodeMenu`) and the right-click node context menu
 * (`GraphContextMenu`) so the two cannot diverge. Both mount it inside a
 * `DropdownMenuContent`, so it emits only the item/separator rows.
 */
export function NodeMenuItems({ isSource, bypassed, onBypass, onReset, onRender, onAbort, onDelete }: NodeMenuActions) {
	return (
		<>
			<DropdownMenuItem onSelect={() => onBypass?.()}>
				<span>{bypassed ? "Enable" : "Bypass"}</span>
			</DropdownMenuItem>

			<DropdownMenuItem onSelect={() => onReset?.()}>
				<span>Reset</span>
			</DropdownMenuItem>

			{!isSource && <DropdownMenuSeparator />}

			{!isSource && (
				<DropdownMenuItem onSelect={() => onRender?.()}>
					<span>Render</span>
				</DropdownMenuItem>
			)}

			{!isSource && (
				<DropdownMenuItem onSelect={() => onAbort?.()}>
					<span>Abort</span>
				</DropdownMenuItem>
			)}

			<DropdownMenuSeparator />

			<DropdownMenuItem onSelect={() => onDelete?.()}>
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
