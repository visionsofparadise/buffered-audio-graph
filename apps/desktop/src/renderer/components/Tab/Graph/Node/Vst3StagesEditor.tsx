import {
	DndContext,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ExternalLink, GripVertical, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../../../utils/cn";
import type { Main } from "../../../../models/Main";
import type { MainEvents } from "../../../../models/MainEvents";
import type { Vst3EditorEventPayload } from "../../../../../shared/ipc/Vst3/Vst3EditorEvent";
import type { Vst3ScanEntry } from "../../../../../shared/ipc/Vst3/Vst3ScanEntry";
import { IconButton } from "../../../IconButton";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../../../DropdownMenu";
import type { ArrayParameter, LeafParameter } from "./utils/buildParameters";
import type { ParameterCallbacks } from "./ParameterRow/ParameterField";
import { paramLabelClass } from "./ParameterRow/utils/labels";

/**
 * Custom editor for the VST3 node's `stages` object-array param. Each stage is a
 * plugin picker (fed by the main-side scanner), an Open button that launches the
 * plugin's own GUI via the bundled vst-demon-cli, and a read-only preset well the
 * editor session owns. Drives the same graph mutations the generic object-array
 * editor does (`onParameterChangeAtPath`, array row add/remove/reorder), so
 * history, persistence, and content hashing are untouched by the UI swap.
 *
 * See design-chain-and-processing.md 2026-07-12 "VST3 node desktop integration".
 */

interface Stage {
	readonly pluginPath: string;
	readonly pluginName: string;
	readonly presetPath: string;
}

interface VendorGroup {
	vendorFolder: string;
	entries: Array<Vst3ScanEntry>;
}

interface RootGroup {
	rootPath: string;
	vendors: Array<VendorGroup>;
}

function readStage(fields: ReadonlyArray<LeafParameter>): Stage {
	const get = (name: string): string => {
		const field = fields.find((candidate) => candidate.name === name);

		return field && typeof field.value === "string" ? field.value : "";
	};

	return { pluginPath: get("pluginPath"), pluginName: get("pluginName"), presetPath: get("presetPath") };
}

function basename(path: string): string {
	const segments = path.split(/[\\/]/);

	return segments[segments.length - 1] ?? path;
}

/** Title = the sub-plugin/plugin name, else the plugin filename minus `.vst3`, else `null` (empty state). */
function stageTitle(stage: Stage): string | null {
	if (stage.pluginName) return stage.pluginName;

	if (stage.pluginPath) return basename(stage.pluginPath).replace(/\.vst3$/i, "");

	return null;
}

/** Group entries by root, then by vendor folder, preserving first-seen order. */
function groupEntries(entries: ReadonlyArray<Vst3ScanEntry>): Array<RootGroup> {
	const roots: Array<RootGroup> = [];

	for (const entry of entries) {
		let root = roots.find((candidate) => candidate.rootPath === entry.rootPath);

		if (!root) {
			root = { rootPath: entry.rootPath, vendors: [] };
			roots.push(root);
		}

		let vendor = root.vendors.find((candidate) => candidate.vendorFolder === entry.vendorFolder);

		if (!vendor) {
			vendor = { vendorFolder: entry.vendorFolder, entries: [] };
			root.vendors.push(vendor);
		}

		vendor.entries.push(entry);
	}

	return roots;
}

export function Vst3StagesEditor({
	param,
	dimmed,
	main,
	mainEvents,
	scanRoots,
	callbacks,
}: {
	readonly param: ArrayParameter;
	readonly dimmed?: boolean;
	readonly main: Main;
	readonly mainEvents: MainEvents;
	readonly scanRoots: ReadonlyArray<string>;
	readonly callbacks: ParameterCallbacks;
}) {
	const [entries, setEntries] = useState<ReadonlyArray<Vst3ScanEntry>>([]);
	const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
	// launchId → the stage's stable rowId (not its positional index): editor
	// windows outlive reorders/removals, so a later `saved` must resolve to the
	// stage that was launched, wherever it now sits.
	const launchRowByIdRef = useRef<Map<string, string>>(new Map());

	const rows = param.rows.map((row) => ({ rowId: row.rowId, stage: readStage(row.fields) }));
	const stagesRef = useRef<ReadonlyArray<Stage>>(rows.map((row) => row.stage));
	const rowIdsRef = useRef<ReadonlyArray<string>>(rows.map((row) => row.rowId));

	stagesRef.current = rows.map((row) => row.stage);
	rowIdsRef.current = rows.map((row) => row.rowId);

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

	// Incremental scan fills — the full current list arrives per emission.
	useEffect(() => {
		const handler = (payload: { entries: Array<Vst3ScanEntry> }): void => {
			setEntries(payload.entries);
		};

		mainEvents.on("vst3:scanUpdate", handler);

		return () => {
			mainEvents.off("vst3:scanUpdate", handler);
		};
	}, [mainEvents]);

	// Editor-session events: the preset path follows `saved` events; a nonzero
	// exit surfaces its stderr tail on the row. Detached cleanly on unmount.
	useEffect(() => {
		const handler = (payload: Vst3EditorEventPayload): void => {
			const rowId = launchRowByIdRef.current.get(payload.launchId);

			if (rowId === undefined) return;

			const rowIndex = rowIdsRef.current.indexOf(rowId);

			if (rowIndex === -1) return; // the stage was removed while its editor was open

			const { event } = payload;

			if (event.event === "saved") {
				const current = stagesRef.current[rowIndex];

				if (current && event.path !== current.presetPath) {
					callbacks.onParameterChangeAtPath?.(["stages", rowIndex, "presetPath"], event.path);
				}
			} else if (event.event === "exited" && event.code !== null && event.code !== 0) {
				setRowErrors((previous) => ({ ...previous, [rowIndex]: event.stderrTail }));
			}
		};

		mainEvents.on("vst3:editorEvent", handler);

		return () => {
			mainEvents.off("vst3:editorEvent", handler);
		};
	}, [mainEvents, callbacks]);

	// Scans run on picker open (and on scan-root changes via Preferences); the
	// return is cached + pending immediately, then `vst3:scanUpdate` fills in.
	const handleScanOpen = useCallback(() => {
		void main
			.vst3ScanPlugins([...scanRoots])
			.then((initial) => {
				setEntries(initial);
			})
			.catch(() => {
				// A scan failure leaves the last-known entries in place.
			});
	}, [main, scanRoots]);

	// One history entry: pluginPath + (className ? pluginName : cleared); preserve any existing preset.
	const handlePick = useCallback(
		(rowIndex: number, entry: Vst3ScanEntry) => {
			const current = stagesRef.current[rowIndex];
			const next: Record<string, unknown> = { pluginPath: entry.modulePath };

			if (current?.presetPath) next.presetPath = current.presetPath;

			if (entry.className !== undefined) next.pluginName = entry.className;

			callbacks.onParameterChangeAtPath?.(["stages", rowIndex], next);
		},
		[callbacks],
	);

	const handleOpen = useCallback(
		async (rowIndex: number) => {
			const stage = stagesRef.current[rowIndex];

			if (!stage?.pluginPath) return;

			setRowErrors((previous) => {
				if (!(rowIndex in previous)) return previous;

				const next: Record<number, string> = {};

				for (const [key, value] of Object.entries(previous)) {
					if (Number(key) !== rowIndex) next[Number(key)] = value;
				}

				return next;
			});

			try {
				const result = await main.vst3LaunchEditor({
					pluginPath: stage.pluginPath,
					pluginName: stage.pluginName || undefined,
					presetPath: stage.presetPath || undefined,
				});

				const rowId = rowIdsRef.current[rowIndex];

				if (rowId !== undefined) launchRowByIdRef.current.set(result.launchId, rowId);
			} catch {
				// A failed spawn surfaces via the `exited` event if the child started; ignore otherwise.
			}
		},
		[main],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;

			if (!over || active.id === over.id) return;

			const fromIndex = rows.findIndex((row) => row.rowId === active.id);
			const toIndex = rows.findIndex((row) => row.rowId === over.id);

			if (fromIndex === -1 || toIndex === -1) return;

			callbacks.onArrayRowReorder?.("stages", fromIndex, toIndex);
		},
		[rows, callbacks],
	);

	return (
		<div className={cn("flex flex-col gap-1", dimmed && "opacity-40")}>
			<span className={paramLabelClass(true)}>Stages</span>

			<div className="flex flex-col gap-3">
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={rows.map((row) => row.rowId)}
						strategy={verticalListSortingStrategy}
					>
						<div className="flex flex-col gap-3">
							{rows.map(({ rowId, stage }, rowIndex) => (
								<SortableStageRow
									key={rowId}
									rowId={rowId}
									rowIndex={rowIndex}
									stage={stage}
									entries={entries}
									error={rowErrors[rowIndex]}
									onScanOpen={handleScanOpen}
									onPick={handlePick}
									onOpen={handleOpen}
									onRemove={() => callbacks.onArrayRowDelete?.("stages", rowIndex)}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>

				<button
					type="button"
					onClick={() => callbacks.onArrayRowAdd?.("stages")}
					className="nodrag type-label inline-flex items-center gap-2 self-start p-1 text-text-secondary hover:text-text-primary"
				>
					<Plus size={14} strokeWidth={1.5} />
					Add stage
				</button>
			</div>
		</div>
	);
}

function SortableStageRow({
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
