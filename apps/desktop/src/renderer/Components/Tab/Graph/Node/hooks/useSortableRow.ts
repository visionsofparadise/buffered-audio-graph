import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DraggableAttributes } from "@dnd-kit/core";
import type { SyntheticListenerMap } from "@dnd-kit/core/dist/hooks/utilities";
import type { CSSProperties } from "react";

export function useSortableRow(rowId: string): {
	readonly setNodeRef: (node: HTMLElement | null) => void;
	readonly style: CSSProperties;
	readonly attributes: DraggableAttributes;
	readonly listeners: SyntheticListenerMap | undefined;
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
