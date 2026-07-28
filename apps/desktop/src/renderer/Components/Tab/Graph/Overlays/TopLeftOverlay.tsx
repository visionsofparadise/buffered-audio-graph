import { Plus } from "lucide-react";
import { useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../../UI/DropdownMenu";
import { PackageNodeList } from "../PackageNodeList";
import type { AppState } from "../../../../Models/State/App";
import type { Snapshot } from "opshot";

interface Props {
	readonly app: Snapshot<AppState>;
	readonly onAddNode: (packageName: string, nodeName: string) => void;
}

export function TopLeftOverlay({ app, onAddNode }: Props) {
	const [open, setOpen] = useState(false);

	return (
		<div className="absolute left-3 top-3 z-10">
			<DropdownMenu open={open} onOpenChange={setOpen}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="flex w-fit items-center gap-2 px-4 py-2 text-body text-text-primary hover:bg-text-primary hover:text-surface data-[state=open]:bg-text-primary data-[state=open]:text-surface"
					>
						<Plus size={16} strokeWidth={1.5} />
						<span>Add node</span>
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="bottom" align="start" className="max-h-[calc(100vh-120px)] w-80 overflow-y-auto">
					<PackageNodeList
						app={app}
						onSelect={(packageName, nodeName) => {
							onAddNode(packageName, nodeName);
							setOpen(false);
						}}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
