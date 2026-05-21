import {
	ReactFlow,
	useNodesState,
	useEdgesState,
	type NodeTypes,
	type EdgeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { DemoNode } from "../components/graph/DemoNode";
import { DemoEdge } from "../components/graph/DemoEdge";
import { DemoContextMenu } from "../components/graph/DemoContextMenu";
import { TopLeftOverlay } from "../components/graph/Overlays/TopLeftOverlay";
import { TopRightOverlay } from "../components/graph/Overlays/TopRightOverlay";
import { BottomLeftOverlay } from "../components/graph/Overlays/BottomLeftOverlay";
import { BottomRightOverlay } from "../components/graph/Overlays/BottomRightOverlay";
import { demoNodes, demoEdges } from "../data/demoGraph";

const NODE_TYPES: NodeTypes = { demoNode: DemoNode };
const EDGE_TYPES: EdgeTypes = { demoEdge: DemoEdge };

const noop = () => {};

export function GraphPage() {
	const [nodes, , onNodesChange] = useNodesState(demoNodes);
	const [edges, , onEdgesChange] = useEdgesState(demoEdges);

	return (
		<DemoContextMenu>
			<div className="relative h-full w-full bg-surface">
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					nodeTypes={NODE_TYPES}
					edgeTypes={EDGE_TYPES}
					fitView
					fitViewOptions={{ padding: 0.3 }}
					defaultEdgeOptions={{ type: "demoEdge" }}
					proOptions={{ hideAttribution: true }}
				>
					<BottomLeftOverlay />
				</ReactFlow>

				<TopLeftOverlay onAddNode={noop} />
				<TopRightOverlay
					isRendering={false}
					onAutoOrganize={noop}
					onUndo={noop}
					onRedo={noop}
					onRender={noop}
					onAbort={noop}
				/>
				<BottomRightOverlay />
			</div>
		</DemoContextMenu>
	);
}
