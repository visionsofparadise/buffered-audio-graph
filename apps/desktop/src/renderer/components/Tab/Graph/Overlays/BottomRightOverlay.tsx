import { Icon } from "@iconify/react";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@buffered-audio/design-system";
import type { Snapshot } from "valtio/vanilla";
import type { AppState } from "../../../../models/State/App";
import { PackageModuleList } from "../PackageModuleList";

interface Props {
	readonly app: Snapshot<AppState>;
	readonly onAddNode: (packageName: string, packageVersion: string, nodeName: string) => void;
}

export function BottomRightOverlay({ app, onAddNode }: Props) {
	return (
		<div className="absolute bottom-3 right-3 z-10">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="primary" size="xl">
						<span className="flex items-center gap-2">
							<Icon icon="lucide:plus" width={16} height={16} />
							<span>Add Node</span>
						</span>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					side="top"
					align="end"
					className="max-h-[calc(100vh-100px)] min-w-56 overflow-y-auto"
				>
					<PackageModuleList app={app} onSelect={onAddNode} />
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
