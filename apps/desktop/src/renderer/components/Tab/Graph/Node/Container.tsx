import { cn } from "../../../../utils/cn";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Power, TriangleAlert } from "lucide-react";
import { NodeMenu } from "./Menu";
import type { ParameterCallbacks } from "./ParameterRow/ParameterField";
import { ParameterField } from "./ParameterRow/ParameterField";
import type { Parameter } from "./utils/buildParameters";

/**
 * Per-node render staleness, derived by `useNodeStates`. It is a content-hash
 * computation only — it no longer paints the node. The redesign moved render
 * progress to global toasts; the type is retained because `Canvas.tsx`,
 * `useNodeStates.ts`, and `nodeLookup.ts` still reference it.
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
	/** Whether the node's input port has an incoming edge. */
	readonly inputConnected: boolean;
	/** Whether the node's output port has an outgoing edge. */
	readonly outputConnected: boolean;
	readonly parameters: ReadonlyArray<Parameter>;
	/**
	 * Non-null when the node class could not be resolved (package/version
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

	// A non-source node's single input is always required — unconnected reads as
	// error attention; connected reads primary. Outputs are optional: connected
	// primary, otherwise the resting secondary tone.
	const inputColor = nodeData.inputConnected ? "bg-text-primary" : "bg-error";
	const outputColor = nodeData.outputConnected ? "bg-text-primary" : "bg-text-secondary";

	const disabled = !nodeData.onParameterChangeAtPath;
	const callbacks: ParameterCallbacks = {
		onParameterChangeAtPath: nodeData.onParameterChangeAtPath,
		onParameterBrowseAtPath: nodeData.onParameterBrowseAtPath,
		onArrayRowAdd: nodeData.onArrayRowAdd,
		onArrayRowDelete: nodeData.onArrayRowDelete,
		onArrayRowReorder: nodeData.onArrayRowReorder,
		disabled,
	};

	const hasObjectArray = nodeData.parameters.some((param) => param.kind === "array");
	const width = hasObjectArray ? 300 : 240;
	const panelShadow = `${selected ? "0 0 0 2px var(--color-accent-primary)," : ""}0 2px 8px rgba(0,0,0,0.3)`;

	return (
		<div className="relative" style={{ width }}>
			<div
				className={cn(
					"flex flex-col overflow-hidden rounded-[2px] bg-elevated",
					isBypassed && "opacity-60",
				)}
				style={{ boxShadow: panelShadow }}
			>
				<div
					className={cn(
						"flex min-h-9 items-center justify-between gap-2 px-4 py-2",
						CATEGORY_HEADER_BG[nodeData.category],
					)}
				>
					<span className="text-body font-medium uppercase leading-tight tracking-[0.06em] text-surface">
						{nodeData.label}
					</span>
					<div className="nodrag flex shrink-0 items-center gap-1.5">
						<button
							type="button"
							aria-label="Bypass"
							onClick={() => nodeData.onBypass?.()}
							className="inline-flex items-center justify-center p-1.5 text-surface hover:bg-[color-mix(in_srgb,var(--color-surface)_20%,transparent)]"
							style={
								isBypassed
									? undefined
									: { backgroundColor: "color-mix(in srgb, var(--color-surface) 25%, transparent)" }
							}
						>
							<Power size={14} strokeWidth={1.5} />
						</button>
						<NodeMenu
							isSource={isSource}
							bypassed={isBypassed}
							onBypass={nodeData.onBypass}
							onReset={nodeData.onReset}
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
							className="mt-0.5 shrink-0 text-error"
						/>
						<div className="flex flex-col gap-1">
							<span className="type-label text-xs text-error">Node unavailable</span>
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
						className={cn(
							"pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2",
							inputColor,
						)}
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
						className={cn(
							"pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2",
							outputColor,
						)}
						style={{ clipPath: "polygon(0 0, 100% 50%, 0 100%)" }}
					/>
				</Handle>
			)}
		</div>
	);
}
