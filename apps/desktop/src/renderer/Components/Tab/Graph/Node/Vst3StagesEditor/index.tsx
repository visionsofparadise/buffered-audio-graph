import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../../../../utils/cn";
import { paramLabelClass } from "../ParameterRow/utils/labels";
import { SortableStageRow } from "./SortableStageRow";
import { readStage, type Stage } from "./utils/helpers";
import type { Vst3EditorEventPayload } from "../../../../../../shared/ipc/Vst3/Vst3EditorEvent";
import type { Vst3ScanEntry } from "../../../../../../shared/ipc/Vst3/Vst3ScanEntry";
import type { Main } from "../../../../../Models/Main";
import type { MainEvents } from "../../../../../Models/MainEvents";
import type { ParameterCallbacks } from "../ParameterRow/utils/callbacks";
import type { ArrayParameter } from "../utils/buildParameters";

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
	const launchRowByIdRef = useRef<Map<string, string>>(new Map());

	const rows = param.rows.map((row) => ({ rowId: row.rowId, stage: readStage(row.fields) }));
	const stagesRef = useRef<ReadonlyArray<Stage>>(rows.map((row) => row.stage));
	const rowIdsRef = useRef<ReadonlyArray<string>>(rows.map((row) => row.rowId));

	stagesRef.current = rows.map((row) => row.stage);
	rowIdsRef.current = rows.map((row) => row.rowId);

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

	useEffect(() => {
		const handler = (payload: { entries: Array<Vst3ScanEntry> }): void => {
			setEntries(payload.entries);
		};

		mainEvents.on("vst3:scanUpdate", handler);

		return () => {
			mainEvents.off("vst3:scanUpdate", handler);
		};
	}, [mainEvents]);

	useEffect(() => {
		const handler = (payload: Vst3EditorEventPayload): void => {
			const rowId = launchRowByIdRef.current.get(payload.launchId);

			if (rowId === undefined) return;

			const rowIndex = rowIdsRef.current.indexOf(rowId);

			if (rowIndex === -1) return;

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

	const handleScanOpen = useCallback(() => {
		void main
			.vst3ScanPlugins([...scanRoots])
			.then((initial) => {
				setEntries(initial);
			})
			.catch(() => undefined);
	}, [main, scanRoots]);

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
			} catch (error) {
				void error;
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
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext items={rows.map((row) => row.rowId)} strategy={verticalListSortingStrategy}>
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
