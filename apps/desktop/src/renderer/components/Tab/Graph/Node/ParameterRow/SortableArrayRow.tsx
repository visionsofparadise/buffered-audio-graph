import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconButton } from "@buffered-audio/design-system";
import { cn } from "../../../../../utils/cn";
import { GripVertical, X } from "lucide-react";
import type { LeafParameter } from "../utils/buildParameters";
import { paramLabelClass } from "./utils/labels";
import type { ParameterCallbacks } from "./ParameterField";
import { LeafField } from "./LeafField";

/**
 * One array element — a sub-form of its field params. Elements after the first
 * carry a single-edge `border-t` divider; the row is reorderable via the drag
 * handle (`@dnd-kit`) and removable via the header `x`.
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
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"flex flex-col gap-4",
				rowIndex > 0 && "border-t border-border pt-4",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				{/* nodrag prevents React Flow from intercepting pointer events the sortable listeners need. */}
				<div
					className="nodrag flex cursor-grab items-center gap-1.5 text-text-secondary active:cursor-grabbing"
					{...attributes}
					{...listeners}
				>
					<GripVertical size={14} strokeWidth={1.5} />
					<span className={paramLabelClass(true)}>{`${itemNoun} ${rowIndex + 1}`}</span>
				</div>
				<IconButton
					icon={X}
					label={`Remove ${itemNoun} ${rowIndex + 1}`}
					variant="ghost"
					size="sm"
					className="nodrag"
					onClick={() => callbacks.onArrayRowDelete?.(paramName, rowIndex)}
				/>
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
				/>
			))}
		</div>
	);
}
