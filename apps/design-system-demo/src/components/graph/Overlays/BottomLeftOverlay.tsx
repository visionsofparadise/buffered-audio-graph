import { MiniMap, type Node as FlowNode } from "@xyflow/react";
import { surface } from "@buffered-audio/design-system";
import type { DemoNodeData } from "../types";

/**
 * BottomLeftOverlay — React Flow MiniMap.
 *
 * This is rendered as a child of `<ReactFlow>` (not absolutely positioned in
 * an overlay layer) because `MiniMap` reads React Flow context. Positioning
 * uses React Flow's built-in Panel placement (`bottom-left`).
 *
 * Container styled per design-components.md "Graph Canvas" → "Bottom-left
 * overlay": `bg-elevated`, ≤2px radius, a subtle `border-border` frame (the
 * graph-canvas surfaces — nodes, toast, minimap — carry this border so they
 * read cleanly against the canvas), ~160×100. Node color follows the node's
 * category; the mask outside the viewport renders in the `surface` token
 * (`#100F0D` on the dark theme) at 60% opacity.
 */

const CATEGORY_COLOR: Record<DemoNodeData["category"], string> = {
	source: "var(--color-category-source)",
	transform: "var(--color-category-transform)",
	target: "var(--color-category-target)",
};

function nodeColor(node: FlowNode): string {
	const data = node.data as DemoNodeData | undefined;

	if (!data) return "var(--color-text-secondary)";

	return CATEGORY_COLOR[data.category];
}

const MASK_COLOR = `color-mix(in srgb, ${surface} 60%, transparent)`;

export function BottomLeftOverlay() {
	return (
		<MiniMap
			position="bottom-left"
			nodeColor={nodeColor}
			maskColor={MASK_COLOR}
			pannable
			zoomable
			ariaLabel="Graph minimap"
			className="!rounded-xs !border !border-border !bg-elevated"
			style={{
				width: 160,
				height: 100,
				backgroundColor: "var(--color-elevated)",
				margin: 12,
			}}
		/>
	);
}
