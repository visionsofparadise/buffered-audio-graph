import { Download, Plus, Redo2, Undo2 } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../../UI/DropdownMenu";
import { NodeMenuItems } from "./Node/Menu";
import { PackageNodeList } from "./PackageNodeList";
import type { AppState } from "../../../Models/State/App";
import type { Snapshot } from "opshot";

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
	readonly isBypassed?: boolean;
	readonly packageName?: string;
	readonly packageVersion?: string;
	readonly canUndo?: boolean;
	readonly canRedo?: boolean;
	readonly renderDisabled?: boolean;
}

export function GraphContextMenu({
	position,
	app,
	onAction,
	onAddNode,
	onClose,
	isBypassed = false,
	packageName = "",
	packageVersion = "",
	canUndo = true,
	canRedo = true,
	renderDisabled = false,
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
					style={{
						position: "fixed",
						left: position.x,
						top: position.y,
						width: 0,
						height: 0,
						pointerEvents: "none",
					}}
					aria-hidden
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={0}>
				{isNode ? (
					<NodeMenuItems
						bypassed={isBypassed}
						packageName={packageName}
						packageVersion={packageVersion}
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
						<DropdownMenuItem disabled={renderDisabled} onSelect={() => onAction("render")}>
							<Download size={14} strokeWidth={1.5} />
							<span>Render</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
