import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@buffered-audio/design-system";
import { Download, Plus, Redo2, Square, Trash2, Undo2 } from "lucide-react";
import type { Snapshot } from "valtio/vanilla";
import type { AppState } from "../../../models/State/App";
import { PackageNodeList } from "./PackageNodeList";

export type ContextMenuAction = "delete" | "render" | "abort" | "undo" | "redo";

export interface ContextMenuPosition {
	readonly x: number;
	readonly y: number;
	readonly nodeId?: string;
}

interface Props {
	readonly position: ContextMenuPosition;
	readonly app: Snapshot<AppState>;
	readonly onAction: (action: ContextMenuAction) => void;
	readonly onAddNode: (packageName: string, packageVersion: string, nodeName: string) => void;
	readonly onClose: () => void;
	/** True when the right-clicked node is a source node — hides Render/Abort. */
	readonly isSourceNode?: boolean;
	readonly canUndo?: boolean;
	readonly canRedo?: boolean;
}

/**
 * Right-click graph context menu. Built on the design-system Radix
 * `DropdownMenu*` primitives, which carry the new menu tokens (`bg-elevated`,
 * 13px rows, active-inversion on hover). Each action row carries a
 * `lucide-react` icon, matching the node menu's treatment.
 *
 * Two variants:
 * - PANE right-click: Add Node, Undo, Redo, Render.
 * - NODE right-click: mirrors the per-node options menu (`Node/Menu.tsx`) —
 *   Render, Abort, Delete, with Render/Abort hidden for source nodes.
 */
export function GraphContextMenu({
	position,
	app,
	onAction,
	onAddNode,
	onClose,
	isSourceNode = false,
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
					<>
						{!isSourceNode && (
							<DropdownMenuItem onSelect={() => onAction("render")}>
								<Download size={14} strokeWidth={1.5} className="shrink-0" />
								<span className="flex-1">Render</span>
							</DropdownMenuItem>
						)}
						{!isSourceNode && (
							<DropdownMenuItem onSelect={() => onAction("abort")}>
								<Square size={14} strokeWidth={1.5} className="shrink-0" />
								<span className="flex-1">Abort</span>
							</DropdownMenuItem>
						)}
						{!isSourceNode && <DropdownMenuSeparator />}
						<DropdownMenuItem
							onSelect={() => onAction("delete")}
							className="text-accent-primary data-[highlighted]:bg-accent-primary data-[highlighted]:text-surface"
						>
							<Trash2 size={14} strokeWidth={1.5} className="shrink-0" />
							<span className="flex-1">Delete</span>
						</DropdownMenuItem>
					</>
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
							<Undo2 size={14} strokeWidth={1.5} className="shrink-0" />
							<span className="flex-1">Undo</span>
						</DropdownMenuItem>
						<DropdownMenuItem disabled={!canRedo} onSelect={() => onAction("redo")}>
							<Redo2 size={14} strokeWidth={1.5} className="shrink-0" />
							<span className="flex-1">Redo</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => onAction("render")}>
							<Download size={14} strokeWidth={1.5} className="shrink-0" />
							<span className="flex-1">Render</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
