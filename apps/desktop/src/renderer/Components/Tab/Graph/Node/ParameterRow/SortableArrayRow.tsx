import { GripVertical, X } from "lucide-react";
import { useSortableRow } from "../hooks/useSortableRow";
import { LeafField } from "./LeafField";
import type { LeafParameter } from "../utils/buildParameters";
import type { ParameterCallbacks } from "./utils/callbacks";

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
	const { setNodeRef, style, attributes, listeners } = useSortableRow(rowId);

	return (
		<div ref={setNodeRef} style={style} className="flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-2">
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
