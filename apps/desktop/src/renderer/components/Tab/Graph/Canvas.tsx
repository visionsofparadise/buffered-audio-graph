import {
	MiniMap,
	ReactFlow,
	useEdgesState,
	useNodesState,
	useReactFlow,
	type Connection,
	type Edge,
	type EdgeTypes,
	type Node as FlowNode,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GraphContext } from "../../../models/Context";
import { resnapshot } from "../../../models/ProxyStore/resnapshot";
import { computeAutoLayout } from "../../../utils/autoLayout";
import { buildDefaultArrayItem, buildParameters, type Parameter } from "./Node/utils/buildParameters";
import { lookupModule, schemaPropertyAtPath } from "./Node/utils/moduleLookup";
import { EdgeContainer } from "./EdgeContainer";
import { GraphContextMenu, type ContextMenuAction, type ContextMenuPosition } from "./GraphContextMenu";
import { useGraphMutations } from "./hooks/useGraphMutations";
import type { NodeContainerData, NodeState } from "./Node/Container";
import { NodeContainer } from "./Node/Container";
import { useNodeStates } from "./hooks/useNodeStates";
import { useRenderJob } from "./hooks/useRenderJob";
import { BottomRightOverlay } from "./Overlays/BottomRightOverlay";
import { TopLeftOverlay } from "./Overlays/TopLeftOverlay";
import { TopRightOverlay } from "./Overlays/TopRightOverlay";

const NODE_TYPES: NodeTypes = { bufferedAudioNode: NodeContainer };
const EDGE_TYPES: EdgeTypes = { bufferedAudioEdge: EdgeContainer };

/** Minimap node color per category — matches the demo `BottomLeftOverlay`. */
const CATEGORY_COLOR: Record<NodeContainerData["category"], string> = {
	source: "var(--color-category-source)",
	transform: "var(--color-category-transform)",
	target: "var(--color-category-target)",
};

function minimapNodeColor(node: FlowNode): string {
	const data = node.data as NodeContainerData | undefined;

	if (!data) return "var(--color-text-secondary)";

	return CATEGORY_COLOR[data.category];
}

function buildReactFlowNodes(
	nodeStates: Map<string, { readonly state: NodeState; readonly hash: string }>,
	processingNodes: Map<string, number>,
	errorNodes: Set<string>,
	context: GraphContext,
): Array<Node<NodeContainerData>> {
	const binaryDefaults = context.app.binaries as Record<string, string>;

	return context.graphDefinition.nodes.map((graphNode) => {
		const packageVersion = typeof graphNode.packageVersion === "string" ? graphNode.packageVersion : "";
		const { category, moduleDescription, schema, unresolvedReason } = lookupModule(
			graphNode.packageName,
			packageVersion,
			graphNode.nodeName,
			context,
		);
		const parameters: Array<Parameter> = buildParameters(graphNode, schema, binaryDefaults);

		let state: NodeState = nodeStates.get(graphNode.id)?.state ?? "pending";
		let progress: number | undefined;

		if (processingNodes.has(graphNode.id)) {
			state = "processing";
			progress = processingNodes.get(graphNode.id);
		} else if (errorNodes.has(graphNode.id)) {
			state = "error";
		}

		return {
			id: graphNode.id,
			type: "bufferedAudioNode",
			position: context.graph.positions[graphNode.id] ?? { x: 0, y: 0 },
			data: {
				label: graphNode.nodeName,
				category,
				state,
				bypassed: graphNode.options?.bypass ?? false,
				parameters,
				unresolvedReason,
				nodeId: graphNode.id,
				description: moduleDescription,
				progress,
			},
		};
	});
}

function buildReactFlowEdges(context: GraphContext): Array<Edge> {
	return context.graphDefinition.edges.map((edge) => ({
		id: `${edge.from}-${edge.to}`,
		source: edge.from,
		target: edge.to,
		sourceHandle: "source",
		targetHandle: "target",
		type: "bufferedAudioEdge",
	}));
}

interface Props {
	readonly context: GraphContext;
}

export const GraphCanvas = resnapshot<Props>(({ context }: Props) => {
	const { nodeStates, refresh } = useNodeStates(context);
	const { startRender, abortRender, processingNodes, errorNodes } = useRenderJob(refresh, context);

	const initialNodes = useMemo(
		() => buildReactFlowNodes(nodeStates, processingNodes, errorNodes, context),

		[],
	);
	const initialEdges = useMemo(
		() => buildReactFlowEdges(context),

		[],
	);

	const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
	const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
	const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);

	const { screenToFlowPosition, getNodes } = useReactFlow();
	const mutations = useGraphMutations(context);

	const handleParameterBrowseAtPath = useCallback(
		async (nodeId: string, path: ReadonlyArray<string | number>) => {
			const graphNode = context.graphDefinition.nodes.find((node) => node.id === nodeId);

			if (!graphNode) return;

			const packageVersion = typeof graphNode.packageVersion === "string" ? graphNode.packageVersion : "";
			const { schema } = lookupModule(
				graphNode.packageName,
				packageVersion,
				graphNode.nodeName,
				context,
			);
			const prop = schemaPropertyAtPath(schema, path);
			const isFolder = prop?.input === "folder";

			const result = await context.main.showOpenDialog({
				properties: [isFolder ? "openDirectory" : "openFile"],
			});

			if (!result?.[0]) return;

			mutations.setParameterAtPath(nodeId, path, result[0]);
		},
		[context, mutations],
	);

	const attachCallbacks = useCallback(
		(builtNodes: Array<Node<NodeContainerData>>): Array<Node<NodeContainerData>> =>
			builtNodes.map((node) => ({
				...node,
				data: {
					...node.data,
					onParameterChangeAtPath: (path: ReadonlyArray<string | number>, value: unknown) => {
						mutations.setParameterAtPath(node.id, path, value);
					},
					onParameterBrowseAtPath: (path: ReadonlyArray<string | number>) => {
						void handleParameterBrowseAtPath(node.id, path);
					},
					onArrayRowAdd: (paramName: string) => {
						const graphNode = context.graphDefinition.nodes.find((gn) => gn.id === node.id);

						if (!graphNode) return;

						const packageVersion = typeof graphNode.packageVersion === "string" ? graphNode.packageVersion : "";
						const { schema } = lookupModule(
							graphNode.packageName,
							packageVersion,
							graphNode.nodeName,
							context,
						);
						const arrayProp = schema?.properties?.[paramName];

						if (arrayProp?.type !== "array" || !arrayProp.items?.properties) return;

						const defaultItem = buildDefaultArrayItem(arrayProp.items.properties);

						mutations.addArrayRow(node.id, paramName, defaultItem);
					},
					onArrayRowDelete: (paramName: string, rowIndex: number) => {
						mutations.deleteArrayRow(node.id, paramName, rowIndex);
					},
					onArrayRowReorder: (paramName: string, fromIndex: number, toIndex: number) => {
						mutations.reorderArrayRows(node.id, paramName, fromIndex, toIndex);
					},
					onBypass: () => {
						mutations.toggleBypass(node.id);
					},
					onDelete: () => {
						mutations.removeNode(node.id);
					},
					onRender: () => void startRender(),
					onAbort: () => void abortRender(),
				},
			})),
		[mutations, handleParameterBrowseAtPath, startRender, abortRender, context],
	);

	useEffect(() => {
		setNodes(attachCallbacks(buildReactFlowNodes(nodeStates, processingNodes, errorNodes, context)));
		setEdges(buildReactFlowEdges(context));
	}, [context, nodeStates, processingNodes, errorNodes, setNodes, setEdges, attachCallbacks]);

	const handleNodesChange = useCallback(
		(changes: Array<NodeChange<Node<NodeContainerData>>>) => {
			onNodesChange(changes);

			for (const change of changes) {
				if (change.type === "position" && change.position && !change.dragging) {
					const nodeId = change.id;
					const position = change.position;

					context.graphStore.mutate(context.graph, (proxy) => {
						proxy.positions[nodeId] = { x: position.x, y: position.y };
					});
				}
			}
		},
		[onNodesChange, context],
	);

	const handleConnect = useCallback(
		(connection: Connection) => {
			mutations.addEdge(connection.source, connection.target);
		},
		[mutations],
	);

	const handleEdgeClick = useCallback(
		(event: React.MouseEvent, edge: Edge) => {
			event.stopPropagation();
			mutations.removeEdge(edge.source, edge.target);
		},
		[mutations],
	);

	const handleNodeContextMenu: NodeMouseHandler<Node> = useCallback((event, node) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
	}, []);

	const handlePaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
		event.preventDefault();
		setContextMenu({ x: event.clientX, y: event.clientY });
	}, []);

	const handlePaneClick = useCallback(() => {
		setContextMenu(null);
	}, []);

	const handleAutoOrganize = useCallback(() => {
		const nextPositions = computeAutoLayout(context.graphDefinition.nodes, context.graphDefinition.edges);

		context.history.mutate(context.graph, (proxy) => {
			proxy.positions = nextPositions;
		});
	}, [context]);

	const closeContextMenu = useCallback(() => {
		setContextMenu(null);
	}, []);

	const handleContextMenuAction = useCallback(
		(action: ContextMenuAction) => {
			if (!contextMenu) return;

			switch (action) {
				case "delete": {
					if (contextMenu.nodeId) {
						mutations.removeNode(contextMenu.nodeId);
					}

					setContextMenu(null);
					break;
				}

				case "render": {
					void startRender();
					setContextMenu(null);
					break;
				}

				case "abort": {
					void abortRender();
					setContextMenu(null);
					break;
				}

				case "undo": {
					context.history.undo();
					setContextMenu(null);
					break;
				}

				case "redo": {
					context.history.redo();
					setContextMenu(null);
					break;
				}
			}
		},
		[contextMenu, mutations, startRender, abortRender, context],
	);

	const handleAddNodeFromContextMenu = useCallback(
		(packageName: string, packageVersion: string, nodeName: string) => {
			if (!contextMenu) return;

			const flowPosition = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });

			mutations.addNode(packageName, packageVersion, nodeName, flowPosition);
			setContextMenu(null);
		},
		[contextMenu, mutations, screenToFlowPosition],
	);

	const handleAddNodeFromButton = useCallback(
		(packageName: string, packageVersion: string, nodeName: string) => {
			const flowPosition = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

			mutations.addNode(packageName, packageVersion, nodeName, flowPosition);
		},
		[mutations, screenToFlowPosition],
	);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement;

			if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
				return;
			}

			if (event.ctrlKey && event.shiftKey && event.key === "Z") {
				event.preventDefault();
				context.history.redo();

				return;
			}

			if (event.ctrlKey && event.key === "z") {
				event.preventDefault();
				context.history.undo();

				return;
			}

			if (event.key === "Delete" || event.key === "Backspace") {
				const selectedNodes = getNodes().filter((node) => node.selected);

				if (selectedNodes.length > 0) {
					event.preventDefault();
					for (const node of selectedNodes) {
						mutations.removeNode(node.id);
					}
				}
			}
		};

		document.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [context, getNodes, mutations]);

	const canUndo = context.history.canUndo;
	const canRedo = context.history.canRedo;
	const isRendering = processingNodes.size > 0;
	const renderProgress =
		processingNodes.size > 0
			? Array.from(processingNodes.values()).reduce((sum, ratio) => sum + ratio, 0) / processingNodes.size
			: 0;

	return (
		<div className="relative h-full w-full bg-surface">
			<style>{`
				.react-flow {
					--xy-background-color: var(--color-surface);
					--xy-node-border-radius: 2px;
					--xy-node-boxshadow-default: none;
					--xy-node-boxshadow-hover: none;
					--xy-node-boxshadow-selected: none;
					--xy-minimap-background: var(--color-elevated);
					--xy-minimap-mask-background: var(--color-surface);
					--xy-controls-button-background: var(--color-elevated);
					--xy-controls-button-color: var(--color-text-secondary);
					--xy-controls-button-border-color: transparent;
					--xy-edge-stroke-default: var(--color-border);
					--xy-handle-background: var(--color-text-secondary);
					--xy-handle-border-color: transparent;
					--xy-selection-background: var(--color-elevated);
					--xy-selection-border: none;
				}

				.react-flow .react-flow__controls {
					border: none;
					border-radius: 2px;
					box-shadow: none;
					background: var(--color-elevated);
				}

				.react-flow .react-flow__controls button {
					background: var(--color-elevated);
					border: none;
					border-radius: 0;
					width: 28px;
					height: 28px;
					padding: 4px;
				}

				.react-flow .react-flow__controls button:hover {
					background: var(--color-text-primary);
				}

				.react-flow .react-flow__controls svg {
					fill: var(--color-text-secondary);
				}

				.react-flow .react-flow__node {
					border-radius: 2px;
					box-shadow: none;
					padding: 0;
				}

				.react-flow .react-flow__attribution {
					display: none;
				}
			`}</style>

			<ReactFlow
				nodes={nodes}
				edges={edges}
				onNodesChange={handleNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={handleConnect}
				nodeTypes={NODE_TYPES}
				edgeTypes={EDGE_TYPES}
				onNodeContextMenu={handleNodeContextMenu}
				onPaneContextMenu={handlePaneContextMenu}
				onPaneClick={handlePaneClick}
				onEdgeClick={handleEdgeClick}
				fitView
				fitViewOptions={{ padding: 0.3 }}
				defaultEdgeOptions={{ type: "bufferedAudioEdge" }}
				proOptions={{ hideAttribution: true }}
			>
				<MiniMap
					position="bottom-left"
					nodeColor={minimapNodeColor}
					maskColor="color-mix(in srgb, var(--color-surface) 60%, transparent)"
					pannable
					zoomable
					ariaLabel="Graph minimap"
					className="!rounded-xs !border !border-border !bg-elevated"
					style={{ width: 160, height: 100, backgroundColor: "var(--color-elevated)", margin: 12 }}
				/>
			</ReactFlow>

			<TopLeftOverlay app={context.app} onAddNode={handleAddNodeFromButton} />
			<TopRightOverlay
				onAutoOrganize={handleAutoOrganize}
				onUndo={() => context.history.undo()}
				onRedo={() => context.history.redo()}
				onSave={context.onSave}
				onRender={() => void startRender()}
				onAbort={() => void abortRender()}
				canUndo={canUndo}
				canRedo={canRedo}
				isRendering={isRendering}
			/>
			<BottomRightOverlay
				isRendering={isRendering}
				graphName={context.graphDefinition.name}
				progress={renderProgress}
				onAbort={() => void abortRender()}
			/>

			{contextMenu && (
				<GraphContextMenu
					position={contextMenu}
					app={context.app}
					onAction={handleContextMenuAction}
					onAddNode={handleAddNodeFromContextMenu}
					onClose={closeContextMenu}
					isSourceNode={
						contextMenu.nodeId !== undefined &&
						nodes.find((node) => node.id === contextMenu.nodeId)?.data.category === "source"
					}
					canUndo={canUndo}
					canRedo={canRedo}
				/>
			)}
		</div>
	);
});
