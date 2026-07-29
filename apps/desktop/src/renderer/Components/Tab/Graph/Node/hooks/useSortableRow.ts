import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { CSSProperties } from "react";

type SortableListeners = ReturnType<typeof useSortable>["listeners"];

export function useSortableRow(rowId: string): {
	readonly setNodeRef: (node: HTMLElement | null) => void;
	readonly style: CSSProperties;
	readonly attributes: DraggableAttributes;
	readonly listeners: SortableListeners;
} {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: rowId });

	return {
		setNodeRef,
		style: {
			transform: CSS.Transform.toString(transform),
			transition,
			opacity: isDragging ? 0.4 : 1,
		},
		attributes,
		listeners,
	};
}
