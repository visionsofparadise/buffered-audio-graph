import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ExternalLink, GripVertical, X } from "lucide-react";
import { basename } from "../../../../../utils/path";
import type { Vst3ScanEntry } from "../../../../../../shared/ipc/Vst3/Vst3ScanEntry";
import { IconButton } from "../../../../UI/IconButton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../../../../UI/DropdownMenu";
import { cn } from "../../../../../utils/cn";
import { groupEntries, stageTitle, type Stage } from "./utils/helpers";

export function SortableStageRow({
	rowId,
	rowIndex,
	stage,
	entries,
	error,
	onScanOpen,
	onPick,
	onOpen,
	onRemove,
}: {
	readonly rowId: string;
	readonly rowIndex: number;
	readonly stage: Stage;
	readonly entries: ReadonlyArray<Vst3ScanEntry>;
	readonly error?: string;
	readonly onScanOpen: () => void;
	readonly onPick: (rowIndex: number, entry: Vst3ScanEntry) => void;
	readonly onOpen: (rowIndex: number) => void;
	readonly onRemove: () => void;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rowId });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : 1,
	};

	const title = stageTitle(stage);
	const groups = groupEntries(entries);

	return (
		<div
			ref={setNodeRef}
			style={style}
			className="flex flex-col gap-2"
		>
			<div className="flex items-center gap-1.5">
				{/* nodrag prevents React Flow from intercepting the sortable pointer events. */}
				<div
					className="nodrag flex cursor-grab items-center text-text-secondary active:cursor-grabbing"
					{...attributes}
					{...listeners}
				>
					<GripVertical size={14} strokeWidth={1.5} />
				</div>

				<DropdownMenu onOpenChange={(open) => open && onScanOpen()}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="Select plugin"
							title={stage.pluginPath || undefined}
							className={cn(
								"nodrag type-label min-w-0 flex-1 truncate text-left outline-none",
								title ? "text-text-secondary" : "text-dimmed",
							)}
						>
							{title ?? "Select plugin…"}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						className="max-h-[400px] overflow-y-auto"
					>
						{entries.length === 0 ? (
							<DropdownMenuLabel>Scanning…</DropdownMenuLabel>
						) : (
							groups.map((root) => (
								<DropdownMenuGroup key={root.rootPath}>
									<DropdownMenuLabel
										className="truncate"
										title={root.rootPath}
									>
										{basename(root.rootPath) || root.rootPath}
									</DropdownMenuLabel>
									{root.vendors.map((vendor) => (
										<DropdownMenuGroup key={`${root.rootPath}::${vendor.vendorFolder}`}>
											{vendor.vendorFolder && (
												<DropdownMenuLabel className="pl-5 text-dimmed">{vendor.vendorFolder}</DropdownMenuLabel>
											)}
											{vendor.entries.map((entry) => (
												<DropdownMenuItem
													key={entry.entryKey}
													disabled={entry.status === "error"}
													onSelect={() => onPick(rowIndex, entry)}
													className="flex-col items-start gap-0.5"
												>
													<span className="truncate">
														{entry.name}
														{entry.status === "pending" ? " …" : ""}
													</span>
													{entry.status === "error" && entry.error && (
														<span className="text-xs normal-case text-error">{entry.error}</span>
													)}
												</DropdownMenuItem>
											))}
										</DropdownMenuGroup>
									))}
								</DropdownMenuGroup>
							))
						)}
					</DropdownMenuContent>
				</DropdownMenu>

				<IconButton
					icon={ExternalLink}
					label="Open editor"
					size="sm"
					disabled={!stage.pluginPath}
					onClick={() => onOpen(rowIndex)}
				/>
				<button
					type="button"
					aria-label={`Remove stage ${rowIndex + 1}`}
					className="nodrag inline-flex items-center justify-center p-1.5 text-text-secondary hover:text-error"
					onClick={onRemove}
				>
					<X size={14} strokeWidth={1.5} />
				</button>
			</div>

			<div className="pl-5">
				<span className="type-label mb-1 block text-text-secondary">Preset</span>
				<div
					className="truncate rounded-xs bg-surface px-2 py-1 text-body text-text-primary"
					title={stage.presetPath || undefined}
				>
					{stage.presetPath ? basename(stage.presetPath) : <span className="text-dimmed">No preset</span>}
				</div>
			</div>

			{error && <p className="whitespace-pre-wrap break-words pl-5 text-body text-error">{error}</p>}
		</div>
	);
}
