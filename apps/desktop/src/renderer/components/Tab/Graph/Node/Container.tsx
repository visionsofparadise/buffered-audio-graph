import { cn } from "../../../../utils/cn";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Power, TriangleAlert } from "lucide-react";
import type { Main } from "../../../../models/Main";
import type { MainEvents } from "../../../../models/MainEvents";
import { NodeMenu } from "./Menu";
import type { ParameterCallbacks } from "./ParameterRow/ParameterField";
import { ParameterField } from "./ParameterRow/ParameterField";
import type { Parameter } from "./utils/buildParameters";
import { Vst3StagesEditor } from "./Vst3StagesEditor";

export type NodeCategory = "source" | "transform" | "target";

/** Full-panel-width header bar tone per category. */
const CATEGORY_HEADER_BG: Record<NodeCategory, string> = {
	source: "bg-category-source",
	transform: "bg-category-transform",
	target: "bg-category-target",
};

export interface NodeContainerData {
	readonly label: string;
	/** The node's package identity (e.g. "@buffered-audio/nodes"). Distinct from `label`. */
	readonly packageName: string;
	/** The node's pinned package version — surfaced read-only in the node menu. */
	readonly packageVersion: string;
	/** The node's class name (e.g. "VST3"). Keys the custom-body branch; distinct from `label`. */
	readonly nodeName: string;
	readonly category: NodeCategory;
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
	/** Path-aware unset (delete key) for an optional leaf returned to AUTO. */
	readonly onParameterUnsetAtPath?: (path: ReadonlyArray<string | number>) => void;
	/** Path-aware browse dialog for file/folder parameters. */
	readonly onParameterBrowseAtPath?: (path: ReadonlyArray<string | number>) => void;
	/** Append a new default row to an array parameter. */
	readonly onArrayRowAdd?: (paramName: string) => void;
	/** Delete a row from an array parameter by index. */
	readonly onArrayRowDelete?: (paramName: string, rowIndex: number) => void;
	/** Reorder array rows. */
	readonly onArrayRowReorder?: (paramName: string, fromIndex: number, toIndex: number) => void;
	/** Toggle the node's bypass flag. */
	readonly onBypass?: () => void;
	readonly onReset?: () => void;
	/** Remove the node from the graph. */
	readonly onDelete?: () => void;
	/** Open a save-mode file param's value in the OS default app. */
	readonly onFileOpen?: (value: string) => void;
	/** Resolves true when a file value names an existing file — drives the open-output button. */
	readonly statFile?: (value: string) => Promise<boolean>;
	/** Bumped when a render completes, re-triggering the open-output existence check. */
	readonly renderEpoch?: number;
	/** Renderer IPC surface — threaded for node bodies (e.g. VST3) that call main directly. */
	readonly main?: Main;
	/** Main→renderer event bus — threaded for node bodies that subscribe to push events. */
	readonly mainEvents?: MainEvents;
	/** VST3 scan roots from AppState — the plugin picker scans these. */
	readonly vst3ScanRoots?: ReadonlyArray<string>;
	[key: string]: unknown;
}

export function NodeContainer({ data, selected }: NodeProps) {
	const nodeData = data as unknown as NodeContainerData;
	const isBypassed = nodeData.bypassed;
	const hasInput = nodeData.category !== "source";
	const hasOutput = nodeData.category !== "target";

	// A non-source node's single input is always required — unconnected reads as
	// error attention; connected reads primary. Outputs are optional: connected
	// primary, otherwise the resting secondary tone.
	const inputColor = nodeData.inputConnected ? "bg-text-primary" : "bg-error";
	const outputColor = nodeData.outputConnected ? "bg-text-primary" : "bg-text-secondary";

	const disabled = !nodeData.onParameterChangeAtPath;
	const callbacks: ParameterCallbacks = {
		onParameterChangeAtPath: nodeData.onParameterChangeAtPath,
		onParameterUnsetAtPath: nodeData.onParameterUnsetAtPath,
		onParameterBrowseAtPath: nodeData.onParameterBrowseAtPath,
		onArrayRowAdd: nodeData.onArrayRowAdd,
		onArrayRowDelete: nodeData.onArrayRowDelete,
		onArrayRowReorder: nodeData.onArrayRowReorder,
		onFileOpen: nodeData.onFileOpen,
		statFile: nodeData.statFile,
		renderEpoch: nodeData.renderEpoch,
		disabled,
	};

	const hasObjectArray = nodeData.parameters.some((param) => param.kind === "array");
	const width = hasObjectArray ? 350 : 290;
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
						"flex min-h-9 cursor-grab items-center justify-between gap-2 px-4 py-2.5 active:cursor-grabbing",
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
							bypassed={isBypassed}
							packageName={nodeData.packageName}
							packageVersion={nodeData.packageVersion}
							onBypass={nodeData.onBypass}
							onReset={nodeData.onReset}
							onDelete={nodeData.onDelete}
						/>
					</div>
				</div>

				{nodeData.unresolvedReason !== null ? (
					<div className="nodrag nopan flex items-start gap-2 px-4 py-4">
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
						<div className="nodrag nopan flex flex-col gap-4 px-4 py-4">
							{nodeData.parameters.map((param) => {
								// The VST3 node's `stages` object-array renders as the custom stage
								// editor (keyed on nodeName, not the package); every other param —
								// and a foreign package reusing the name without a `stages` array —
								// falls through to the generic ParameterField.
								if (
									nodeData.nodeName === "VST3" &&
									param.kind === "array" &&
									param.name === "stages" &&
									nodeData.main &&
									nodeData.mainEvents
								) {
									return (
										<Vst3StagesEditor
											key={param.name}
											param={param}
											dimmed={isBypassed}
											main={nodeData.main}
											mainEvents={nodeData.mainEvents}
											scanRoots={nodeData.vst3ScanRoots ?? []}
											callbacks={callbacks}
										/>
									);
								}

								return (
									<ParameterField
										key={param.name}
										param={param}
										basePath={[]}
										dimmed={isBypassed}
										callbacks={callbacks}
									/>
								);
							})}
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
