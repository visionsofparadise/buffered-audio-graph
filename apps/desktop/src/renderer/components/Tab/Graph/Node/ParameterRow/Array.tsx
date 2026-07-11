import {
	DndContext,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "../../../../../utils/cn";
import { Plus } from "lucide-react";
import type { ArrayParameter } from "../utils/buildParameters";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";
import type { ParameterCallbacks } from "./ParameterField";
import { SortableArrayRow } from "./SortableArrayRow";

/**
 * Array editor — a reorderable, addable, removable list of element sub-forms.
 * Children are field params; rows render via {@link SortableArrayRow}.
 */
export function ArrayRow({
	param,
	dimmed,
	callbacks,
}: {
	readonly param: ArrayParameter;
	readonly dimmed?: boolean;
	readonly callbacks: ParameterCallbacks;
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 6 },
		}),
	);

	const itemNoun = humanizeFieldName(param.name);

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;

		if (!over || active.id === over.id) return;

		const fromIndex = param.rows.findIndex((row) => row.rowId === active.id);
		const toIndex = param.rows.findIndex((row) => row.rowId === over.id);

		if (fromIndex === -1 || toIndex === -1) return;

		callbacks.onArrayRowReorder?.(param.name, fromIndex, toIndex);
	};

	return (
		<div className={cn("flex flex-col gap-1", dimmed && "opacity-40")}>
			<span className={paramLabelClass(true)}>{itemNoun}</span>

			<div className="flex flex-col gap-3">
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					onDragEnd={handleDragEnd}
				>
					<SortableContext
						items={param.rows.map((row) => row.rowId)}
						strategy={verticalListSortingStrategy}
					>
						<div className="flex flex-col gap-3">
							{param.rows.map((row, rowIndex) => (
								<SortableArrayRow
									key={row.rowId}
									rowId={row.rowId}
									rowIndex={rowIndex}
									paramName={param.name}
									itemNoun={itemNoun}
									fields={row.fields}
									dimmed={dimmed}
									callbacks={callbacks}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>

				<button
					type="button"
					onClick={() => callbacks.onArrayRowAdd?.(param.name)}
					className="nodrag type-label inline-flex items-center gap-2 self-start p-1 text-text-secondary hover:text-text-primary"
				>
					<Plus size={14} strokeWidth={1.5} />
					{`Add ${itemNoun}`}
				</button>
			</div>
		</div>
	);
}
