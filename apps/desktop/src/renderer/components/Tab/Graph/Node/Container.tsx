import { IconButton } from "@buffered-audio/design-system";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import type { Logger } from "../../../../../shared/models/Logger";
import type { Main } from "../../../../models/Main";
import { NodeMenu } from "./Menu";
import { SnapshotPreview } from "./SnapshotPreview";
import type { ParameterCallbacks } from "./ParameterRow/ParameterField";
import { ParameterField } from "./ParameterRow/ParameterField";
import type { Parameter } from "./utils/buildParameters";

/** Stable inputs the per-node snapshot waveform preview needs to discover and read the latest snapshot. */
export interface SnapshotPreviewData {
	readonly main: Main;
	readonly logger: Logger;
	readonly userDataPath: string;
	readonly bagId: string;
}

export type NodeState = "rendered" | "stale" | "processing" | "pending" | "error" | "bypassed";
export type NodeCategory = "source" | "transform" | "target";

export interface NodeContainerData {
	readonly label: string;
	readonly category: NodeCategory;
	readonly state: NodeState;
	readonly bypassed: boolean;
	readonly parameters: ReadonlyArray<Parameter>;
	readonly inspected?: boolean;
	/** Stable inputs for the per-node snapshot waveform preview. */
	readonly snapshotPreview?: SnapshotPreviewData;
	readonly nodeId?: string;
	readonly description?: string;
	readonly error?: string;
	readonly progress?: number;
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
	[key: string]: unknown;
}

export function NodeContainer({ data, selected }: NodeProps) {
	const nodeData = data as unknown as NodeContainerData;
	const isBypassed = nodeData.bypassed;
	const isInspected = nodeData.inspected ?? false;
	const hasInput = nodeData.category !== "source";
	const hasOutput = nodeData.category !== "target";
	const isSource = nodeData.category === "source";
	const snapshotPreview = nodeData.snapshotPreview;
	const previewNodeId = nodeData.nodeId;
	const isProcessing = nodeData.state === "processing";
	const isPending = nodeData.state === "pending";
	const hasError = nodeData.error !== undefined;
	const progress = nodeData.progress;

	const disabled = !nodeData.onParameterChangeAtPath;
	const callbacks: ParameterCallbacks = {
		onParameterChangeAtPath: nodeData.onParameterChangeAtPath,
		onParameterBrowseAtPath: nodeData.onParameterBrowseAtPath,
		onArrayRowAdd: nodeData.onArrayRowAdd,
		onArrayRowDelete: nodeData.onArrayRowDelete,
		onArrayRowReorder: nodeData.onArrayRowReorder,
		disabled,
	};

	let renderLabel: string | null = null;

	if (!isSource && !isBypassed) {
		if (isProcessing) renderLabel = "Abort";
		else renderLabel = "Render";
	}

	return (
		<div
			className="relative"
			style={{ width: 260 }}
		>
			<div
				className={`flex flex-col gap-1 ${isBypassed ? "bg-chrome-base" : "bg-chrome-surface"} ${selected ? "ring-1 ring-interactive-focus" : ""} ${isInspected ? "ring-1 ring-primary" : ""}`}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-3 pt-2 pb-1">
					<span className={`font-body text-[length:var(--text-base)] font-medium ${isBypassed ? "text-chrome-text-dim" : "text-chrome-text"}`}>{nodeData.label}</span>
					<div className="flex items-center">
						{isSource && (
							<IconButton
								icon="lucide:eye"
								label="Inspect"
								active={isInspected}
								activeVariant="primary"
							/>
						)}
						<IconButton
							icon="lucide:power"
							label="Bypass"
							active={isBypassed}
							activeVariant="secondary"
						/>
						<NodeMenu
							isSource={isSource}
							isProcessing={isProcessing}
							isPending={isPending}
							isBypassed={isBypassed}
							isInspected={isInspected}
							onRender={nodeData.onRender}
							onAbort={nodeData.onAbort}
						/>
					</div>
				</div>

				{/* Description */}
				{nodeData.description && (
					<div className="px-3 pb-2">
						<span className="font-body text-[length:var(--text-xs)] text-chrome-text-secondary">{nodeData.description}</span>
					</div>
				)}

				{/* Parameters */}
				{nodeData.parameters.length > 0 && (
					<div className="flex flex-col gap-3 px-3 pb-3">
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
				)}

				{/* Render / Abort / Pending footer */}
				{renderLabel && (
					<div className="flex items-center justify-end px-3 pb-2">
						{isProcessing && progress !== undefined && (
							<div className="mr-auto flex items-center gap-2">
								<div className="h-1 w-20 bg-chrome-raised">
									<div
										className="h-full bg-state-processing"
										style={{ width: `${progress * 100}%` }}
									/>
								</div>
								<span className="font-technical text-[length:var(--text-xs)] tabular-nums text-state-processing">{Math.round(progress * 100)}%</span>
							</div>
						)}
						<button
							type="button"
							onClick={isProcessing ? nodeData.onAbort : nodeData.onRender}
							className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${
								isProcessing
									? "bg-state-error text-void hover:bg-state-error/80 cursor-pointer"
									: "bg-chrome-raised text-chrome-text-dim hover:text-chrome-text-secondary cursor-pointer"
							}`}
						>
							{renderLabel}
						</button>
					</div>
				)}

				{/* Ports */}
				{hasInput && (
					<Handle
						type="target"
						position={Position.Left}
						id="target"
						className="!bg-chrome-text-dim !border-0 !rounded-none"
						style={{ left: -5, width: 8, height: 10, clipPath: "polygon(0% 0%, 100% 50%, 0% 100%)" }}
					/>
				)}
				{hasOutput && (
					<Handle
						type="source"
						position={Position.Right}
						id="source"
						className="!bg-chrome-text-dim !border-0 !rounded-none"
						style={{ right: -5, width: 8, height: 10, clipPath: "polygon(0% 0%, 0% 100%, 100% 50%)" }}
					/>
				)}
			</div>

			{!isBypassed && snapshotPreview && previewNodeId !== undefined && (
				<SnapshotPreview
					main={snapshotPreview.main}
					logger={snapshotPreview.logger}
					userDataPath={snapshotPreview.userDataPath}
					bagId={snapshotPreview.bagId}
					nodeId={previewNodeId}
				/>
			)}

			{hasError && (
				<div className="mt-3 flex items-start gap-1.5 bg-state-error/20 px-3 py-2 ring-1 ring-state-error/40">
					<AlertTriangle
						size={12}
						className="mt-0.5 shrink-0 text-state-error"
					/>
					<span className="font-body text-[length:var(--text-xs)] text-state-error">{nodeData.error}</span>
				</div>
			)}
		</div>
	);
}
