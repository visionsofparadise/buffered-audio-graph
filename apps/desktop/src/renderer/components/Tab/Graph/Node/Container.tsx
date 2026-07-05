import { cn } from "../../../../utils/cn";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { TriangleAlert } from "lucide-react";
import { NodeMenu } from "./Menu";
import type { ParameterCallbacks } from "./ParameterRow/ParameterField";
import { ParameterField } from "./ParameterRow/ParameterField";
import type { Parameter } from "./utils/buildParameters";

/**
 * Per-node render staleness, derived by `useNodeStates`. It is a content-hash
 * computation only — it no longer paints the node. The redesign moved render
 * progress to global toasts; the type is retained because `Canvas.tsx`,
 * `useNodeStates.ts`, and `moduleLookup.ts` still reference it.
 */
export type NodeState = "rendered" | "stale" | "processing" | "pending" | "error" | "bypassed";
export type NodeCategory = "source" | "transform" | "target";

/** Full-panel-width header bar tone per category. */
const CATEGORY_HEADER_BG: Record<NodeCategory, string> = {
	source: "bg-category-source",
	transform: "bg-category-transform",
	target: "bg-category-target",
};

export interface NodeContainerData {
	readonly label: string;
	readonly category: NodeCategory;
	/** Content-hash staleness — computed but not painted on the node. */
	readonly state: NodeState;
	readonly bypassed: boolean;
	readonly parameters: ReadonlyArray<Parameter>;
	/**
	 * Non-null when the node's module could not be resolved (package/version
	 * not installed, or the node is absent from the package). The body renders
	 * this reason in place of the parameter controls.
	 */
	readonly unresolvedReason: string | null;
	readonly nodeId?: string;
	readonly description?: string;
	/** Path-aware leaf value change — path is [topLevelName, ...nestedKeys]. */
	readonly onParameterChangeAtPath?: (path: ReadonlyArray<string | number>, value: unknown) => void;
	/** Path-aware browse dialog for file/folder parameters. */
	readonly onParameterBrowseAtPath?: (path: ReadonlyArray<string | number>) => void;
	/** Append a new default row to an array parameter. */
	readonly onArrayRowAdd?: (paramName: string) => void;
	/** Delete a row from an array parameter by index. */
	readonly onArrayRowDelete?: (paramName: string, rowIndex: number) => void;
	/** Reorder array rows. */
	readonly onArrayRowReorder?: (paramName: string, fromIndex: number, toIndex: number) => void;
	readonly onRender?: () => void;
	readonly onAbort?: () => void;
	/** Toggle the node's bypass flag. */
	readonly onBypass?: () => void;
	readonly onReset?: () => void;
	/** Remove the node from the graph. */
	readonly onDelete?: () => void;
	[key: string]: unknown;
}

export function NodeContainer({ data, selected }: NodeProps) {
	const nodeData = data as unknown as NodeContainerData;
	const isBypassed = nodeData.bypassed;
	const hasInput = nodeData.category !== "source";
	const hasOutput = nodeData.category !== "target";
	const isSource = nodeData.category === "source";

	const disabled = !nodeData.onParameterChangeAtPath;
	const callbacks: ParameterCallbacks = {
		onParameterChangeAtPath: nodeData.onParameterChangeAtPath,
		onParameterBrowseAtPath: nodeData.onParameterBrowseAtPath,
		onArrayRowAdd: nodeData.onArrayRowAdd,
		onArrayRowDelete: nodeData.onArrayRowDelete,
		onArrayRowReorder: nodeData.onArrayRowReorder,
		disabled,
	};

	return (
		<div className="relative" style={{ width: 260 }}>
			<div
				className={cn(
					"flex flex-col overflow-hidden rounded-xs border border-border bg-elevated",
					isBypassed && "opacity-60",
					selected && "ring-1 ring-text-primary",
				)}
			>
				<div
					className={cn(
						"flex min-h-9 items-center justify-between gap-2 px-3 py-2",
						CATEGORY_HEADER_BG[nodeData.category],
					)}
				>
					<span className="text-body font-medium uppercase leading-tight tracking-[0.06em] text-surface">
						{nodeData.label}
					</span>
					<div className="flex shrink-0 items-center gap-0.5">
						<NodeMenu
							isSource={isSource}
							onRender={nodeData.onRender}
							onAbort={nodeData.onAbort}
							onDelete={nodeData.onDelete}
						/>
					</div>
				</div>

				{nodeData.unresolvedReason !== null ? (
					<div className="nodrag nopan flex items-start gap-2 px-3 py-4">
						<TriangleAlert
							size={14}
							strokeWidth={1.5}
							className="mt-0.5 shrink-0 text-accent-primary"
						/>
						<div className="flex flex-col gap-1">
							<span className="type-label text-xs text-accent-primary">Module unavailable</span>
							<span className="text-xs leading-snug text-text-secondary">{nodeData.unresolvedReason}</span>
						</div>
					</div>
				) : (
					nodeData.parameters.length > 0 && (
						<div className="nodrag nopan flex flex-col gap-4 px-3 py-4">
							{nodeData.parameters.map((param) => (
								<ParameterField
									key={param.name}
									param={param}
									basePath={[]}
									dimmed={isBypassed}
									callbacks={callbacks}
								/>
							))}
						</div>
					)
				)}
			</div>

			{hasInput && (
				<Handle
					type="target"
					position={Position.Left}
					id="target"
					className="!h-5 !w-5 !rounded-none !border-0 !bg-transparent"
					style={{ left: -10 }}
				>
					<span
						className="pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 bg-text-secondary"
						style={{ clipPath: "polygon(0 0, 100% 50%, 0 100%)" }}
					/>
				</Handle>
			)}
			{hasOutput && (
				<Handle
					type="source"
					position={Position.Right}
					id="source"
					className="!h-5 !w-5 !rounded-none !border-0 !bg-transparent"
					style={{ right: -10 }}
				>
					<span
						className="pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 bg-text-secondary"
						style={{ clipPath: "polygon(0 0, 100% 50%, 0 100%)" }}
					/>
				</Handle>
			)}
		</div>
	);
}
