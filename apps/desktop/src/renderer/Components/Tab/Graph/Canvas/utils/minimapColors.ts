import type { NodeContainerData } from "../../Node/Container";
import type { Node as FlowNode } from "@xyflow/react";

const CATEGORY_COLOR: Record<NodeContainerData["category"], string> = {
	source: "var(--color-category-source)",
	transform: "var(--color-category-transform)",
	target: "var(--color-category-target)",
};

export function minimapNodeColor(node: FlowNode): string {
	const data = node.data as NodeContainerData | undefined;

	if (!data) return "var(--color-text-secondary)";

	return CATEGORY_COLOR[data.category];
}
