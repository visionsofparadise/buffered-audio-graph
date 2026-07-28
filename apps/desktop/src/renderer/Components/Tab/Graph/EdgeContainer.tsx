import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Snapshot } from "opshot";
import type { AppState } from "../../../Models/State/App";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "../../UI/DropdownMenu";
import { PackageNodeList } from "./PackageNodeList";
import { EDGE_HIT_CURSOR } from "./utils/edgeHitCursor";

export interface EdgeContainerData {
	readonly app: Snapshot<AppState>;
	readonly onInsert: (packageName: string, nodeName: string) => void;
	[key: string]: unknown;
}

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
	data,
}: EdgeProps) {
	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	const edgeData = data as EdgeContainerData | undefined;

	const [hovered, setHovered] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const enter = (): void => {
		clearTimeout(leaveTimer.current);
		setHovered(true);
	};
	const leave = (): void => {
		clearTimeout(leaveTimer.current);
		leaveTimer.current = setTimeout(() => setHovered(false), 140);
	};

	const restStroke = selected ? "var(--color-text-primary)" : "var(--color-border)";
	const stroke = hovered ? "color-mix(in srgb, var(--color-error) 65%, var(--color-border))" : restStroke;
	const chipVisible = hovered || menuOpen;

	return (
		<>
			<BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ stroke, strokeWidth: hovered ? 2 : 1 }} />
			<path
				d={edgePath}
				fill="none"
				stroke="transparent"
				strokeWidth={20}
				style={{ cursor: EDGE_HIT_CURSOR, pointerEvents: "stroke" }}
				onMouseEnter={enter}
				onMouseLeave={leave}
			/>
			<EdgeLabelRenderer>
				{chipVisible && edgeData && (
					<div
						className="nodrag nopan"
						data-edge-insert
						style={{
							position: "absolute",
							transform: `translate(-50%, -50%) translate(${String(labelX)}px, ${String(labelY)}px)`,
							pointerEvents: "all",
							zIndex: 15,
						}}
						onMouseEnter={enter}
						onMouseLeave={leave}
						onClick={(event) => event.stopPropagation()}
						onPointerDown={(event) => event.stopPropagation()}
						onMouseDown={(event) => event.stopPropagation()}
					>
						<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="Insert node"
									className="inline-flex h-6 w-6 items-center justify-center rounded-[2px] bg-elevated text-text-primary shadow-[0_2px_8px_rgba(0,0,0,0.45)] hover:bg-accent-primary hover:text-surface"
								>
									<Plus size={14} strokeWidth={1.5} />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="center"
								side="bottom"
								className="max-h-[calc(100vh-160px)] w-80 overflow-y-auto"
							>
								<DropdownMenuLabel className="text-dimmed">Insert node here</DropdownMenuLabel>
								<PackageNodeList
									app={edgeData.app}
									onSelect={(packageName, nodeName) => {
										edgeData.onInsert(packageName, nodeName);
										setMenuOpen(false);
									}}
								/>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				)}
			</EdgeLabelRenderer>
		</>
	);
}
