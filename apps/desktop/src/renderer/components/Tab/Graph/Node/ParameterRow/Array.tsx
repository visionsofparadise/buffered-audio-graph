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
import { Button } from "@buffered-audio/design-system";
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
		<div className={cn("flex flex-col gap-4", dimmed && "opacity-40")}>
			<span className={paramLabelClass(true)}>{itemNoun}</span>

			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={param.rows.map((row) => row.rowId)}
					strategy={verticalListSortingStrategy}
				>
					<div className="flex flex-col gap-4">
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

			<Button
				variant="ghost"
				size="sm"
				icon={Plus}
				onClick={() => callbacks.onArrayRowAdd?.(param.name)}
				className="nodrag self-start px-1"
			>
				{`Add ${itemNoun}`}
			</Button>
		</div>
	);
}
