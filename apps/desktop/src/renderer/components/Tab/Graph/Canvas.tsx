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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphContext } from "../../../models/Context";
import { resnapshot } from "../../../models/ProxyStore/resnapshot";
import { computeAutoLayout } from "../../../utils/autoLayout";
import { buildDefaultArrayItem, buildParameters, type Parameter } from "./Node/utils/buildParameters";
import { lookupNode, schemaPropertyAtPath } from "./Node/utils/nodeLookup";
import { EdgeContainer } from "./EdgeContainer";
import { GraphContextMenu, type ContextMenuAction, type ContextMenuPosition } from "./GraphContextMenu";
import { useGraphMutations } from "./hooks/useGraphMutations";
import type { NodeContainerData } from "./Node/Container";
import { NodeContainer } from "./Node/Container";
import { unreadyRenderPairs, useRenderJob } from "./hooks/useRenderJob";
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

function buildReactFlowNodes(context: GraphContext): Array<Node<NodeContainerData>> {
	const binaryDefaults = context.app.binaries as Record<string, string>;
	const connectedInputs = new Set(context.graphDefinition.edges.map((edge) => edge.to));
	const connectedOutputs = new Set(context.graphDefinition.edges.map((edge) => edge.from));

	return context.graphDefinition.nodes.map((graphNode) => {
		const { category, description, schema, unresolvedReason } = lookupNode(
			graphNode.packageName,
			graphNode.packageVersion,
			graphNode.nodeName,
			context,
		);
		const parameters: Array<Parameter> = buildParameters(graphNode, schema, binaryDefaults);

		return {
			id: graphNode.id,
			type: "bufferedAudioNode",
			position: context.graph.positions[graphNode.id] ?? { x: 0, y: 0 },
			data: {
				label: graphNode.nodeName,
				packageName: graphNode.packageName,
				packageVersion: graphNode.packageVersion,
				nodeName: graphNode.nodeName,
				category,
				bypassed: graphNode.options?.bypass ?? false,
				inputConnected: connectedInputs.has(graphNode.id),
				outputConnected: connectedOutputs.has(graphNode.id),
				parameters,
				unresolvedReason,
				nodeId: graphNode.id,
				description,
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
	const { startRender, abortRender, clearRenderError, activeJobId, processingNodes, renderError } = useRenderJob(context);

	const initialNodes = useMemo(
		() => buildReactFlowNodes(context),

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

	const [renderEpoch, setRenderEpoch] = useState(0);
	const wasRenderingRef = useRef(false);

	useEffect(() => {
		const rendering = activeJobId !== null;

		if (wasRenderingRef.current && !rendering) {
			setRenderEpoch((epoch) => epoch + 1);
		}

		wasRenderingRef.current = rendering;
	}, [activeJobId]);

	const handleParameterBrowseAtPath = useCallback(
		async (nodeId: string, path: ReadonlyArray<string | number>) => {
			const graphNode = context.graphDefinition.nodes.find((node) => node.id === nodeId);

			if (!graphNode) return;

			const { schema } = lookupNode(
				graphNode.packageName,
				graphNode.packageVersion,
				graphNode.nodeName,
				context,
			);
			const prop = schemaPropertyAtPath(schema, path);

			const extensions = prop?.accept
				? prop.accept.split(",").map((entry) => entry.trim().replace(/^\./, "")).filter((entry) => entry !== "")
				: [];
			const filters = extensions.length > 0 ? [{ name: extensions.join(", ").toUpperCase(), extensions }] : undefined;

			if (prop?.mode === "save") {
				let current: unknown = graphNode.parameters;

				for (const segment of path) {
					if (current === null || typeof current !== "object") {
						current = undefined;
						break;
					}

					current = (current as Record<string | number, unknown>)[segment];
				}

				const currentValue = typeof current === "string" ? current : "";

				const savePath = await context.main.showSaveDialog({
					title: `Save "${String(path[path.length - 1])}"`,
					defaultPath: currentValue !== "" ? currentValue : undefined,
					filters,
				});

				if (savePath === undefined) return;

				mutations.setParameterAtPath(nodeId, path, savePath);

				return;
			}

			const isFolder = prop?.input === "folder";

			const result = await context.main.showOpenDialog({
				properties: [isFolder ? "openDirectory" : "openFile"],
				filters: isFolder ? undefined : filters,
			});

			if (!result?.[0]) return;

			mutations.setParameterAtPath(nodeId, path, result[0]);
		},
		[context, mutations],
	);

	const openFileOutput = useCallback(
		(value: string) => {
			void context.main.openPath(value);
		},
		[context.main],
	);

	const statFile = useCallback(
		(value: string) => context.main.stat(value).then((stats) => stats.isFile).catch(() => false),
		[context.main],
	);

	const attachEdgeData = useCallback(
		(builtEdges: Array<Edge>): Array<Edge> =>
			builtEdges.map((edge) => ({
				...edge,
				data: {
					app: context.app,
					onInsert: (packageName: string, nodeName: string) => {
						mutations.insertNodeOnEdge({ from: edge.source, to: edge.target }, packageName, nodeName);
					},
				},
			})),
		[context.app, mutations],
	);

	const attachCallbacks = useCallback(
		(builtNodes: Array<Node<NodeContainerData>>): Array<Node<NodeContainerData>> =>
			builtNodes.map((node) => ({
				...node,
				data: {
					...node.data,
					// Threaded for custom node bodies (VST3 stage editor) that call main /
					// subscribe to push events directly; Context.ts is untouched.
					main: context.main,
					mainEvents: context.mainEvents,
					vst3ScanRoots: context.app.vst3ScanRoots,
					onParameterChangeAtPath: (path: ReadonlyArray<string | number>, value: unknown) => {
						mutations.setParameterAtPath(node.id, path, value);
					},
					onParameterUnsetAtPath: (path: ReadonlyArray<string | number>) => {
						mutations.deleteParameterAtPath(node.id, path);
					},
					onParameterBrowseAtPath: (path: ReadonlyArray<string | number>) => {
						void handleParameterBrowseAtPath(node.id, path);
					},
					onArrayRowAdd: (paramName: string) => {
						const graphNode = context.graphDefinition.nodes.find((gn) => gn.id === node.id);

						if (!graphNode) return;

						const { schema } = lookupNode(
							graphNode.packageName,
							graphNode.packageVersion,
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
					onReset: () => {
						mutations.resetNodeParameters(node.id);
					},
					onDelete: () => {
						mutations.removeNode(node.id);
					},
					onFileOpen: openFileOutput,
					statFile,
					renderEpoch,
				},
			})),
		[mutations, handleParameterBrowseAtPath, context, renderEpoch, openFileOutput, statFile],
	);

	useEffect(() => {
		setNodes(attachCallbacks(buildReactFlowNodes(context)));
		setEdges(attachEdgeData(buildReactFlowEdges(context)));
	}, [context, setNodes, setEdges, attachCallbacks, attachEdgeData]);

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

				case "bypass": {
					if (contextMenu.nodeId) {
						mutations.toggleBypass(contextMenu.nodeId);
					}

					setContextMenu(null);
					break;
				}

				case "reset": {
					if (contextMenu.nodeId) {
						mutations.resetNodeParameters(contextMenu.nodeId);
					}

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
		[contextMenu, mutations, startRender, context],
	);

	const handleAddNodeFromContextMenu = useCallback(
		(packageName: string, nodeName: string) => {
			if (!contextMenu) return;

			const flowPosition = screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y });

			mutations.addNode(packageName, nodeName, flowPosition);
			setContextMenu(null);
		},
		[contextMenu, mutations, screenToFlowPosition],
	);

	const handleAddNodeFromButton = useCallback(
		(packageName: string, nodeName: string) => {
			const flowPosition = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

			mutations.addNode(packageName, nodeName, flowPosition);
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

	const renderReadiness = useMemo(() => {
		const missing = unreadyRenderPairs(context.graphDefinition.nodes, context.app.packages);

		return {
			ready: missing.length === 0,
			reason: missing.length > 0 ? `Packages not ready: ${missing.join(", ")}` : undefined,
		};
	}, [context.graphDefinition.nodes, context.app.packages]);

	const contextMenuNode =
		contextMenu?.nodeId !== undefined ? nodes.find((node) => node.id === contextMenu.nodeId) : undefined;

	const canUndo = context.history.canUndo;
	const canRedo = context.history.canRedo;
	const isRendering = activeJobId !== null;
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
					cursor: default;
				}

				.react-flow .react-flow__node.dragging {
					cursor: grabbing;
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
					className="!rounded-[2px] !bg-elevated shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
					style={{ width: 160, height: 100, backgroundColor: "var(--color-elevated)", margin: 12 }}
				/>
			</ReactFlow>

			<TopLeftOverlay app={context.app} onAddNode={handleAddNodeFromButton} />
			<TopRightOverlay
				onAutoOrganize={handleAutoOrganize}
				onUndo={() => context.history.undo()}
				onRedo={() => context.history.redo()}
				onRender={() => void startRender()}
				onAbort={() => void abortRender()}
				canUndo={canUndo}
				canRedo={canRedo}
				isRendering={isRendering}
				isRenderReady={renderReadiness.ready}
				renderDisabledReason={renderReadiness.reason}
			/>
			<BottomRightOverlay
				isRendering={isRendering}
				renderError={renderError}
				graphName={context.graphDefinition.name}
				progress={renderProgress}
				onDismiss={() => {
					void abortRender();
					clearRenderError();
				}}
			/>

			{contextMenu && (
				<GraphContextMenu
					position={contextMenu}
					app={context.app}
					onAction={handleContextMenuAction}
					onAddNode={handleAddNodeFromContextMenu}
					onClose={closeContextMenu}
					isBypassed={contextMenuNode?.data.bypassed ?? false}
					packageName={contextMenuNode?.data.packageName ?? ""}
					packageVersion={contextMenuNode?.data.packageVersion ?? ""}
					canUndo={canUndo}
					canRedo={canRedo}
					renderDisabled={!renderReadiness.ready}
				/>
			)}
		</div>
	);
});
