import { cn } from "../../../../utils/cn";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Power, TriangleAlert } from "lucide-react";
import type { Main } from "../../../../Models/Main";
import type { MainEvents } from "../../../../Models/MainEvents";
import { NodeMenu } from "./Menu";
import type { ParameterCallbacks } from "./ParameterRow/ParameterField";
import { ParameterField } from "./ParameterRow/ParameterField";
import type { Parameter } from "./utils/buildParameters";
import { Vst3StagesEditor } from "./Vst3StagesEditor";
import { CATEGORY_HEADER_BG } from "./utils/categoryHeaderBg";

export type NodeCategory = "source" | "transform" | "target";

export interface NodeContainerData {
	readonly label: string;
	readonly packageName: string;
	readonly packageVersion: string;
	readonly nodeName: string;
	readonly category: NodeCategory;
	readonly bypassed: boolean;
	readonly inputConnected: boolean;
	readonly outputConnected: boolean;
	readonly parameters: ReadonlyArray<Parameter>;
	readonly unresolvedReason: string | null;
	readonly nodeId?: string;
	readonly description?: string;
	readonly onParameterChangeAtPath?: (path: ReadonlyArray<string | number>, value: unknown) => void;
	readonly onParameterUnsetAtPath?: (path: ReadonlyArray<string | number>) => void;
	readonly onParameterBrowseAtPath?: (path: ReadonlyArray<string | number>) => void;
	readonly onArrayRowAdd?: (paramName: string) => void;
	readonly onArrayRowDelete?: (paramName: string, rowIndex: number) => void;
	readonly onArrayRowReorder?: (paramName: string, fromIndex: number, toIndex: number) => void;
	readonly onBypass?: () => void;
	readonly onReset?: () => void;
	readonly onDelete?: () => void;
	readonly onFileOpen?: (value: string) => void;
	readonly statFile?: (value: string) => Promise<boolean>;
	readonly renderEpoch?: number;
	readonly main?: Main;
	readonly mainEvents?: MainEvents;
	readonly vst3ScanRoots?: ReadonlyArray<string>;
	[key: string]: unknown;
}

export function NodeContainer({ data, selected }: NodeProps) {
	const nodeData = data as unknown as NodeContainerData;
	const isBypassed = nodeData.bypassed;
	const hasInput = nodeData.category !== "source";
	const hasOutput = nodeData.category !== "target";

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
				className={cn("flex flex-col overflow-hidden rounded-[2px] bg-elevated", isBypassed && "opacity-60")}
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
						<TriangleAlert size={14} strokeWidth={1.5} className="mt-0.5 shrink-0 text-error" />
						<div className="flex flex-col gap-1">
							<span className="type-label text-xs text-error">Node unavailable</span>
							<span className="text-xs leading-snug text-text-secondary">{nodeData.unresolvedReason}</span>
						</div>
					</div>
				) : (
					nodeData.parameters.length > 0 && (
						<div className="nodrag nopan flex flex-col gap-4 px-4 py-4">
							{nodeData.parameters.map((param) => {
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
							"clip-arrow pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2",
							inputColor,
						)}
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
							"clip-arrow pointer-events-none absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2",
							outputColor,
						)}
					/>
				</Handle>
			)}
		</div>
	);
}
