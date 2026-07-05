import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useState } from "react";

/**
 * Custom React Flow edge. Edges are monochrome — `border` tone at rest,
 * `text-primary` when connected/selected. The visual-language redesign
 * removed the former idle/active/complete state coloring and the dash-flow
 * animation; an edge's only visual states are rest and selected.
 *
 * Edges are click-to-delete: hovering an edge previews this by switching the
 * stroke to the coral `accent-primary` and showing a pointer cursor. The
 * actual deletion is wired on `<ReactFlow onEdgeClick>` in `Canvas.tsx`.
 */
export function EdgeContainer({
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

	const [hovered, setHovered] = useState(false);

	const restStroke = selected ? "var(--color-text-primary)" : "var(--color-border)";
	const stroke = hovered ? "var(--color-accent-primary)" : restStroke;

	return (
		<g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			<path d={edgePath} fill="none" stroke="transparent" strokeWidth={20} style={{ cursor: "pointer" }} />
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd={markerEnd}
				style={{
					stroke,
					strokeWidth: 1,
					cursor: "pointer",
				}}
			/>
		</g>
	);
}
