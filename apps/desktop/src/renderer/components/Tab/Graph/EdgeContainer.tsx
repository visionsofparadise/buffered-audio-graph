import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { Snapshot } from "opshot";
import type { AppState } from "../../../models/State/App";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "../../DropdownMenu";
import { PackageNodeList } from "./PackageNodeList";

/**
 * Custom React Flow edge. Edges are monochrome — `border` tone at rest,
 * `text-primary` when selected. Click-to-delete: the wide transparent hit path
 * under the visible stroke deletes the edge (wired on `<ReactFlow onEdgeClick>`
 * in `Canvas.tsx`). Hovering previews the delete by switching the stroke to an
 * `error`-mixed tone at 2px and showing the X-glyph cursor on the hit path.
 *
 * While the edge is hovered (with a ~140ms leave grace so the pointer can reach
 * the chip), a shadowed `+` chip renders at the edge midpoint via
 * `EdgeLabelRenderer`. Clicking it opens the grouped node catalog
 * (`PackageNodeList`, titled "Insert node here"); picking a node calls
 * `insertNodeOnEdge` through the `onInsert` callback carried on edge data.
 */

const EDGE_HIT_CURSOR =
	"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22'%3E%3Cline x1='6' y1='6' x2='16' y2='16' stroke='%23E5484D' stroke-width='2.5' stroke-linecap='round'/%3E%3Cline x1='16' y1='6' x2='6' y2='16' stroke='%23E5484D' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E\") 11 11, pointer";

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
							<DropdownMenuContent align="center" side="bottom" className="max-h-[calc(100vh-160px)] w-80 overflow-y-auto">
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
