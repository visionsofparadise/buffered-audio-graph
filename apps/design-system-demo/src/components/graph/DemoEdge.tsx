import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

/**
 * Demo edge — bezier path in the warm border tone. Selected state inverts to
 * text-primary.
 */
export function DemoEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	selected,
	markerEnd,
}: EdgeProps) {
	const [edgePath] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	return (
		<BaseEdge
			id={id}
			path={edgePath}
			markerEnd={markerEnd}
			style={{
				stroke: selected ? "var(--color-text-primary)" : "var(--color-border)",
				strokeWidth: 1,
			}}
		/>
	);
}
