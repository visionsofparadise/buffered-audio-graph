import { Plus } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@buffered-audio/design-system";
import type { Snapshot } from "valtio/vanilla";
import type { AppState } from "../../../../models/State/App";
import { PackageModuleList } from "../PackageModuleList";

/**
 * TopLeftOverlay — Add-Node trigger.
 *
 * The primary action of the graph workspace (top-left primary-action
 * position). Styled to match the home-screen action buttons exactly: a plain
 * transparent button, `px-4 py-2 text-body`, title-case label, 16px leading
 * icon, white hover-inversion (`hover:bg-text-primary hover:text-surface`),
 * plus the active-inversion while the node menu is open. The node list itself
 * is the desktop's package-registry-driven `PackageModuleList`.
 */

interface Props {
	readonly app: Snapshot<AppState>;
	readonly onAddNode: (packageName: string, packageVersion: string, nodeName: string) => void;
}

export function TopLeftOverlay({ app, onAddNode }: Props) {
	return (
		<div className="absolute left-3 top-3 z-10">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex w-fit items-center gap-2 px-4 py-2 text-body text-text-primary hover:bg-text-primary hover:text-surface data-[state=open]:bg-text-primary data-[state=open]:text-surface"
					>
						<Plus size={16} strokeWidth={1.5} />
						<span>Add node</span>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					side="bottom"
					align="start"
					className="max-h-[calc(100vh-120px)] w-80 overflow-y-auto"
				>
					<PackageModuleList app={app} onSelect={onAddNode} />
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
