import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../../DropdownMenu";
import { Download, Plus, Redo2, Undo2 } from "lucide-react";
import type { Snapshot } from "valtio/vanilla";
import type { AppState } from "../../../models/State/App";
import { NodeMenuItems } from "./Node/Menu";
import { PackageNodeList } from "./PackageNodeList";

export type ContextMenuAction = "delete" | "render" | "undo" | "redo" | "bypass" | "reset";

export interface ContextMenuPosition {
	readonly x: number;
	readonly y: number;
	readonly nodeId?: string;
}

interface Props {
	readonly position: ContextMenuPosition;
	readonly app: Snapshot<AppState>;
	readonly onAction: (action: ContextMenuAction) => void;
	readonly onAddNode: (packageName: string, nodeName: string) => void;
	readonly onClose: () => void;
	/** Current bypass state of the right-clicked node — drives the Bypass/Enable label. */
	readonly isBypassed?: boolean;
	readonly canUndo?: boolean;
	readonly canRedo?: boolean;
}

/**
 * Right-click graph context menu. Flat `bg-elevated` Radix menu, 13px uppercase
 * rows with hover inversion.
 *
 * Two variants:
 * - PANE right-click: Add Node, Undo, Redo, Render.
 * - NODE right-click: the exact node-action vocabulary, rendered from the shared
 *   `NodeMenuItems` so the dots menu and the right-click menu cannot diverge.
 */
export function GraphContextMenu({
	position,
	app,
	onAction,
	onAddNode,
	onClose,
	isBypassed = false,
	canUndo = true,
	canRedo = true,
}: Props) {
	const isNode = position.nodeId !== undefined;

	return (
		<DropdownMenu
			open
			onOpenChange={(nextOpen) => {
				if (!nextOpen) onClose();
			}}
		>
			<DropdownMenuTrigger asChild>
				<div
					style={{ position: "fixed", left: position.x, top: position.y, width: 0, height: 0, pointerEvents: "none" }}
					aria-hidden
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={0}>
				{isNode ? (
					<NodeMenuItems
						bypassed={isBypassed}
						onBypass={() => onAction("bypass")}
						onReset={() => onAction("reset")}
						onDelete={() => onAction("delete")}
					/>
				) : (
					<>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<Plus size={14} strokeWidth={1.5} />
								<span className="flex-1">Add Node</span>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[calc(100vh-100px)] w-80 overflow-y-auto">
								<PackageNodeList app={app} onSelect={onAddNode} />
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem disabled={!canUndo} onSelect={() => onAction("undo")}>
							<Undo2 size={14} strokeWidth={1.5} />
							<span>Undo</span>
						</DropdownMenuItem>
						<DropdownMenuItem disabled={!canRedo} onSelect={() => onAction("redo")}>
							<Redo2 size={14} strokeWidth={1.5} />
							<span>Redo</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => onAction("render")}>
							<Download size={14} strokeWidth={1.5} />
							<span>Render</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
