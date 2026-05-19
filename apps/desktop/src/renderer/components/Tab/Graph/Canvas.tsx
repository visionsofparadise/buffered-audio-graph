import {
	Background,
	BackgroundVariant,
	MiniMap,
	ReactFlow,
	useEdgesState,
	useNodesState,
	useReactFlow,
	type Connection,
	type Edge,
	type EdgeTypes,
	type Node,
	type NodeChange,
	type NodeMouseHandler,
	type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GraphContext } from "../../../models/Context";
import { computeAutoLayout } from "../../../utilities/autoLayout";
import { buildDefaultArrayItem, buildParameters, type Parameter } from "./Node/utils/buildParameters";
import { lookupModule, schemaPropertyAtPath } from "./Node/utils/moduleLookup";
import { EdgeContainer } from "./EdgeContainer";
import { GraphContextMenu, type ContextMenuAction, type ContextMenuPosition } from "./GraphContextMenu";
import { useGraphMutations } from "./hooks/useGraphMutations";
import type { NodeContainerData, NodeState, SnapshotPreviewData } from "./Node/Container";
import { NodeContainer } from "./Node/Container";
import { useNodeStates } from "./hooks/useNodeStates";
import { useRenderJob } from "./hooks/useRenderJob";
import { BottomRightOverlay } from "./Overlays/BottomRightOverlay";
import { TopLeftOverlay } from "./Overlays/TopLeftOverlay";
import { TopRightOverlay } from "./Overlays/TopRightOverlay";

interface AudioEdgeData {
	readonly state: "idle" | "active" | "complete";
	[key: string]: unknown;
}

const NODE_TYPES: NodeTypes = { bufferedAudioNode: NodeContainer };
const EDGE_TYPES: EdgeTypes = { bufferedAudioEdge: EdgeContainer };

function buildReactFlowNodes(
	context: GraphContext,
	nodeStates: Map<string, { readonly state: NodeState; readonly hash: string }>,
	processingNodes: Map<string, number>,
	errorNodes: Set<string>,
	snapshotPreview: SnapshotPreviewData,
): Array<Node<NodeContainerData>> {
	const binaryDefaults = context.app.binaries as Record<string, string>;

	return context.graphDefinition.nodes.map((graphNode) => {
		const packageVersion = typeof graphNode.packageVersion === "string" ? graphNode.packageVersion : "";
		const { category, moduleDescription, schema } = lookupModule(
			context,
			graphNode.packageName,
			packageVersion,
			graphNode.nodeName,
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
				inspected: graphNode.id === context.graph.inspectedNodeId,
				snapshotPreview,
				nodeId: graphNode.id,
				description: moduleDescription,
				progress,
			},
		};
	});
}

function deriveEdgeState(
	sourceId: string,
	targetId: string,
	nodeStates: Map<string, { readonly state: NodeState; readonly hash: string }>,
	processingNodes: Map<string, number>,
): AudioEdgeData["state"] {
	const sourceState = processingNodes.has(sourceId) ? "processing" : nodeStates.get(sourceId)?.state ?? "pending";
	const targetState = processingNodes.has(targetId) ? "processing" : nodeStates.get(targetId)?.state ?? "pending";

	if (sourceState === "rendered" && targetState === "rendered") return "complete";
	if (sourceState === "rendered" && targetState === "processing") return "active";

	return "idle";
}

function buildReactFlowEdges(
	context: GraphContext,
	nodeStates: Map<string, { readonly state: NodeState; readonly hash: string }>,
	processingNodes: Map<string, number>,
): Array<Edge<AudioEdgeData>> {
	return context.graphDefinition.edges.map((edge) => ({
		id: `${edge.from}-${edge.to}`,
		source: edge.from,
		target: edge.to,
		sourceHandle: "source",
		targetHandle: "target",
		type: "bufferedAudioEdge",
		data: { state: deriveEdgeState(edge.from, edge.to, nodeStates, processingNodes) },
	}));
}

interface Props {
	readonly context: GraphContext;
}

export function GraphCanvas({ context }: Props) {
	const { nodeStates, refresh } = useNodeStates(context);
	const { startRender, abortRender, processingNodes, errorNodes } = useRenderJob(context, refresh);

	const snapshotPreview = useMemo<SnapshotPreviewData>(
		() => ({ main: context.main, logger: context.logger, userDataPath: context.userDataPath, bagId: context.bagId }),
		[context.main, context.logger, context.userDataPath, context.bagId],
	);

	const initialNodes = useMemo(
		() => buildReactFlowNodes(context, nodeStates, processingNodes, errorNodes, snapshotPreview),

		[],
	);
	const initialEdges = useMemo(
		() => buildReactFlowEdges(context, nodeStates, processingNodes),

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
				context,
				graphNode.packageName,
				packageVersion,
				graphNode.nodeName,
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
							context,
							graphNode.packageName,
							packageVersion,
							graphNode.nodeName,
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
					onRender: () => void startRender(),
					onAbort: () => void abortRender(),
				},
			})),
		[mutations, handleParameterBrowseAtPath, startRender, abortRender, context],
	);

	// Sync from graph definition (source of truth) into React Flow state
	useEffect(() => {
		setNodes(attachCallbacks(buildReactFlowNodes(context, nodeStates, processingNodes, errorNodes, snapshotPreview)));
		setEdges(buildReactFlowEdges(context, nodeStates, processingNodes));
	}, [context, nodeStates, processingNodes, errorNodes, setNodes, setEdges, attachCallbacks, snapshotPreview]);

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
		const previousPositions = structuredClone(context.graph.positions as Record<string, { x: number; y: number }>);
		const nextPositions = computeAutoLayout(context.graphDefinition.nodes, context.graphDefinition.edges);

		context.graphStore.mutate(context.graph, (proxy) => {
			proxy.positions = nextPositions;
		});

		context.pushHistory({
			label: "Auto-organize",
			undo: () => {
				context.graphStore.mutate(context.graph, (proxy) => {
					proxy.positions = structuredClone(previousPositions);
				});
			},
			redo: () => {
				context.graphStore.mutate(context.graph, (proxy) => {
					proxy.positions = structuredClone(nextPositions);
				});
			},
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

				case "bypass": {
					if (contextMenu.nodeId) {
						mutations.toggleBypass(contextMenu.nodeId);
					}

					setContextMenu(null);
					break;
				}

				case "render": {
					void startRender();
					setContextMenu(null);
					break;
				}
			}
		},
		[contextMenu, mutations, startRender],
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

	// Keyboard shortcuts: undo/redo, delete selected nodes
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Don't capture when an input/textarea is focused
			const target = event.target as HTMLElement;

			if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
				return;
			}

			if (event.ctrlKey && event.shiftKey && event.key === "Z") {
				event.preventDefault();
				context.redo();

				return;
			}

			if (event.ctrlKey && event.key === "z") {
				event.preventDefault();
				context.undo();

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

	const canUndo = context.history.cursor > 0;
	const canRedo = context.history.cursor < context.history.entries.length;
	const isRendering = processingNodes.size > 0;

	return (
		<div className="relative h-full w-full">
			<style>{`
				.react-flow {
					--xy-background-color: var(--color-void);
					--xy-node-border-radius: 0;
					--xy-node-boxshadow-default: 0 2px 8px rgba(0, 0, 0, 0.5);
					--xy-node-boxshadow-hover: 0 4px 16px rgba(0, 0, 0, 0.6);
					--xy-node-boxshadow-selected: 0 4px 16px rgba(0, 0, 0, 0.6);
					--xy-minimap-background: var(--color-chrome-surface);
					--xy-minimap-mask-background: var(--color-chrome-base);
					--xy-controls-button-background: var(--color-chrome-raised);
					--xy-controls-button-color: var(--color-chrome-text);
					--xy-controls-button-border-color: transparent;
					--xy-edge-stroke-default: var(--color-edge-idle);
					--xy-handle-background: var(--color-chrome-surface);
					--xy-handle-border-color: transparent;
					--xy-selection-background: var(--color-data-selection);
					--xy-selection-border: none;
				}

				.react-flow .react-flow__controls {
					border: none;
					border-radius: 0;
					box-shadow: none;
					background: var(--color-chrome-raised);
				}

				.react-flow .react-flow__controls button {
					background: var(--color-chrome-raised);
					border: none;
					border-radius: 0;
					width: 28px;
					height: 28px;
					padding: 4px;
				}

				.react-flow .react-flow__controls button:hover {
					background: var(--color-interactive-hover);
				}

				.react-flow .react-flow__controls svg {
					fill: var(--color-chrome-text);
				}

				.react-flow .react-flow__minimap {
					border: none;
					border-radius: 0;
					box-shadow: none;
					background: var(--color-chrome-surface);
				}

				.react-flow .react-flow__node {
					border-radius: 0;
					box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
					padding: 0;
				}

				.react-flow .react-flow__attribution {
					display: none;
				}

				@keyframes pulse-header {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.5; }
				}

				@keyframes dash-flow {
					from { stroke-dashoffset: 10; }
					to { stroke-dashoffset: 0; }
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
				fitView
				fitViewOptions={{ padding: 0.3 }}
				defaultEdgeOptions={{ type: "bufferedAudioEdge" }}
				proOptions={{ hideAttribution: true }}
			>
				<Background
					variant={BackgroundVariant.Dots}
					gap={20}
					size={1}
					color="var(--color-chrome-surface)"
				/>
				<MiniMap
					nodeColor="var(--chrome-raised)"
					nodeStrokeColor="var(--chrome-border-subtle)"
					nodeStrokeWidth={1}
					maskColor="var(--chrome-base)"
					position="bottom-left"
					pannable
					zoomable
				/>
			</ReactFlow>

			<TopLeftOverlay context={context} />
			<TopRightOverlay
				onAutoOrganize={handleAutoOrganize}
				onUndo={context.undo}
				onRedo={context.redo}
				onRender={() => void startRender()}
				onAbort={() => void abortRender()}
				canUndo={canUndo}
				canRedo={canRedo}
				isRendering={isRendering}
			/>
			<BottomRightOverlay app={context.app} onAddNode={handleAddNodeFromButton} />

			{contextMenu && (
				<GraphContextMenu
					position={contextMenu}
					app={context.app}
					onAction={handleContextMenuAction}
					onAddNode={handleAddNodeFromContextMenu}
					onClose={closeContextMenu}
				/>
			)}
		</div>
	);
}
