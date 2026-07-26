import type { NodeCategory } from "../Node/Container";

export const CATEGORY_ORDER: ReadonlyArray<{ readonly key: NodeCategory; readonly label: string }> = [
	{ key: "source", label: "Sources" },
	{ key: "transform", label: "Transforms" },
	{ key: "target", label: "Targets" },
];
