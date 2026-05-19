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
import type { Snapshot } from "valtio/vanilla";
import type { AppState } from "../../../models/State/App";
import { PackageModuleList } from "./PackageModuleList";

export type ContextMenuAction = "delete" | "bypass" | "render";

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
}

export function GraphContextMenu({ position, app, onAction, onAddNode, onClose }: Props) {
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
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<span className="flex-1">Add Node</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="max-h-[calc(100vh-100px)] min-w-56 overflow-y-auto">
						<PackageModuleList app={app} onSelect={onAddNode} />
					</DropdownMenuSubContent>
				</DropdownMenuSub>

				{isNode && (
					<>
						<DropdownMenuItem onSelect={() => onAction("delete")}>
							<span className="flex-1">Delete Node</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onAction("bypass")}>
							<span className="flex-1">Bypass / Enable</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onAction("render")}>
							<span className="flex-1">Render</span>
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
