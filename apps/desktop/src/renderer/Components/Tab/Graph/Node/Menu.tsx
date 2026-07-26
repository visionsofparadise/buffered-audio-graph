import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../UI/DropdownMenu";
import { IconButton } from "../../../UI/IconButton";
import { EllipsisVertical, Power, RotateCcw, Trash2 } from "lucide-react";

export interface NodeMenuActions {
	readonly bypassed: boolean;
	readonly packageName: string;
	readonly packageVersion: string;
	readonly onBypass?: () => void;
	readonly onReset?: () => void;
	readonly onDelete?: () => void;
}

export function NodeMenuItems({ bypassed, packageName, packageVersion, onBypass, onReset, onDelete }: NodeMenuActions) {
	return (
		<>
			{packageName !== "" && (
				<>
					<DropdownMenuLabel
						title={`${packageName}@${packageVersion}`}
						className="max-w-64 truncate text-dimmed"
					>
						{packageName}@{packageVersion}
					</DropdownMenuLabel>
					<DropdownMenuSeparator />
				</>
			)}

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
