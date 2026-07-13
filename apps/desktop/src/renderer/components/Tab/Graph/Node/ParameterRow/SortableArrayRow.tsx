import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import type { LeafParameter } from "../utils/buildParameters";
import type { ParameterCallbacks } from "./ParameterField";
import { LeafField } from "./LeafField";

/**
 * One array element — a sub-form of its field params. The element title reads
 * `<Noun> N` (10px uppercase); the row is reorderable via the drag handle
 * (`@dnd-kit`) and removable via the header `×` (hover `error`).
 */
export function SortableArrayRow({
	rowId,
	rowIndex,
	paramName,
	itemNoun,
	fields,
	dimmed,
	callbacks,
}: {
	readonly rowId: string;
	readonly rowIndex: number;
	readonly paramName: string;
	readonly itemNoun: string;
	readonly fields: ReadonlyArray<LeafParameter>;
	readonly dimmed?: boolean;
	readonly callbacks: ParameterCallbacks;
}) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rowId });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.4 : 1,
	};

	return (
		<div ref={setNodeRef} style={style} className="flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-2">
				{/* nodrag prevents React Flow from intercepting pointer events the sortable listeners need. */}
				<div
					className="nodrag flex cursor-grab items-center gap-1.5 text-text-secondary active:cursor-grabbing"
					{...attributes}
					{...listeners}
				>
					<GripVertical size={14} strokeWidth={1.5} />
					<span className="type-label text-text-secondary">{`${itemNoun} ${rowIndex + 1}`}</span>
				</div>
				<button
					type="button"
					aria-label={`Remove ${itemNoun} ${rowIndex + 1}`}
					className="nodrag inline-flex items-center justify-center p-1.5 text-text-secondary hover:text-error"
					onClick={() => callbacks.onArrayRowDelete?.(paramName, rowIndex)}
				>
					<X size={14} strokeWidth={1.5} />
				</button>
			</div>

			{fields.map((field) => (
				<LeafField
					key={field.name}
					param={field}
					dimmed={dimmed}
					disabled={callbacks.disabled}
					onParameterChange={(fieldName, value) => {
						callbacks.onParameterChangeAtPath?.([paramName, rowIndex, fieldName], value);
					}}
					onParameterBrowse={(fieldName) => {
						callbacks.onParameterBrowseAtPath?.([paramName, rowIndex, fieldName]);
					}}
					onParameterUnset={(fieldName) => {
						callbacks.onParameterUnsetAtPath?.([paramName, rowIndex, fieldName]);
					}}
				/>
			))}
		</div>
	);
}
