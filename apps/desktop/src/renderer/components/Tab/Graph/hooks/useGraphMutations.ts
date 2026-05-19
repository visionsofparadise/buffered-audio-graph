import type { GraphEdge, GraphNode } from "@buffered-audio/core";
import { useMemo, useRef } from "react";
import type { GraphContext } from "../../../../models/Context";

interface Position {
	x: number;
	y: number;
}

interface GraphMutations {
	addNode: (packageName: string, packageVersion: string, nodeName: string, position: Position) => void;
	removeNode: (nodeId: string) => void;
	addEdge: (from: string, to: string) => void;
	removeEdge: (from: string, to: string) => void;
	insertNodeOnEdge: (edge: GraphEdge, packageName: string, packageVersion: string, nodeName: string) => void;
	toggleBypass: (nodeId: string) => void;
	setGraphName: (name: string) => void;
	/** Set a nested parameter value at a path. path[0] is the top-level parameter name. */
	setParameterAtPath: (nodeId: string, path: ReadonlyArray<string | number>, value: unknown) => void;
	/** Append a new item (plain JSON object) to an array parameter. */
	addArrayRow: (nodeId: string, paramName: string, defaultItem: Record<string, unknown>) => void;
	/** Remove an item from an array parameter by index. */
	deleteArrayRow: (nodeId: string, paramName: string, rowIndex: number) => void;
	/** Move an item in an array parameter from one index to another. */
	reorderArrayRows: (nodeId: string, paramName: string, fromIndex: number, toIndex: number) => void;
}

export function useGraphMutations(context: GraphContext): GraphMutations {
	// Stable mutations object: read latest context via ref so each method always sees
	// current graphDefinition/mutateDefinition/pushHistory without churning identity.
	// Without this, every render returned a new {} and cascaded into Canvas's setNodes
	// effect, hitting React's "Maximum update depth exceeded".
	const contextRef = useRef(context);

	contextRef.current = context;

	return useMemo<GraphMutations>(() => {
		function addNode(packageName: string, packageVersion: string, nodeName: string, position: Position): void {
			const { mutateDefinition, pushHistory, graphStore, graph } = contextRef.current;
			const id = crypto.randomUUID();

			const node: GraphNode = {
				id,
				packageName,
				packageVersion,
				nodeName,
				parameters: {},
			};

			mutateDefinition((definition) => ({
				...definition,
				nodes: [...definition.nodes, node],
			}));

			graphStore.mutate(graph, (proxy) => {
				proxy.positions[id] = { x: position.x, y: position.y };
			});

			pushHistory({
				label: `Add ${nodeName}`,
				undo: () => {
					const current = contextRef.current;

					current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.filter((node) => node.id !== id),
					}));
					current.graphStore.mutate(current.graph, (proxy) => {
						const { [id]: _removedPosition, ...remainingPositions } = proxy.positions;

						proxy.positions = remainingPositions;
					});
				},
				redo: () => {
					const current = contextRef.current;

					current.mutateDefinition((definition) => ({
						...definition,
						nodes: [...definition.nodes, node],
					}));
					current.graphStore.mutate(current.graph, (proxy) => {
						proxy.positions[id] = { x: position.x, y: position.y };
					});
				},
			});
		}

		function removeNode(nodeId: string): void {
			const { graphDefinition, mutateDefinition, pushHistory, graphStore, graph } = contextRef.current;
			const removedNode = graphDefinition.nodes.find((node) => node.id === nodeId);
			const removedEdges = graphDefinition.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId);
			const removedPosition = graphDefinition.nodes.find((node) => node.id === nodeId) ? graph.positions[nodeId] : undefined;

			mutateDefinition((definition) => ({
				...definition,
				nodes: definition.nodes.filter((node) => node.id !== nodeId),
				edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
			}));

			graphStore.mutate(graph, (proxy) => {
				const { [nodeId]: _removedPosition, ...remainingPositions } = proxy.positions;

				proxy.positions = remainingPositions;
			});

			pushHistory({
				label: `Remove node`,
				undo: () => {
					const current = contextRef.current;

					current.mutateDefinition((definition) => ({
						...definition,
						nodes: removedNode ? [...definition.nodes, removedNode] : definition.nodes,
						edges: [...definition.edges, ...removedEdges],
					}));
					if (removedPosition) {
						current.graphStore.mutate(current.graph, (proxy) => {
							proxy.positions[nodeId] = { x: removedPosition.x, y: removedPosition.y };
						});
					}
				},
				redo: () => {
					const current = contextRef.current;

					current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.filter((node) => node.id !== nodeId),
						edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
					}));
					current.graphStore.mutate(current.graph, (proxy) => {
						const { [nodeId]: _removedPosition, ...remainingPositions } = proxy.positions;

						proxy.positions = remainingPositions;
					});
				},
			});
		}

		function addEdge(from: string, to: string): void {
			const { mutateDefinition, pushHistory } = contextRef.current;
			const edge: GraphEdge = { from, to };

			mutateDefinition((definition) => ({
				...definition,
				edges: [...definition.edges, edge],
			}));

			pushHistory({
				label: `Connect ${from} to ${to}`,
				undo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						edges: definition.edges.filter((edge) => !(edge.from === from && edge.to === to)),
					}));
				},
				redo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						edges: [...definition.edges, edge],
					}));
				},
			});
		}

		function removeEdge(from: string, to: string): void {
			const { mutateDefinition, pushHistory } = contextRef.current;

			mutateDefinition((definition) => ({
				...definition,
				edges: definition.edges.filter((edge) => !(edge.from === from && edge.to === to)),
			}));

			pushHistory({
				label: `Disconnect ${from} from ${to}`,
				undo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						edges: [...definition.edges, { from, to }],
					}));
				},
				redo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						edges: definition.edges.filter((edge) => !(edge.from === from && edge.to === to)),
					}));
				},
			});
		}

		function insertNodeOnEdge(edge: GraphEdge, packageName: string, packageVersion: string, nodeName: string): void {
			const { mutateDefinition, pushHistory, graphStore, graph } = contextRef.current;
			const id = crypto.randomUUID();

			const node: GraphNode = {
				id,
				packageName,
				packageVersion,
				nodeName,
				parameters: {},
			};

			const fromPosition = graph.positions[edge.from];
			const toPosition = graph.positions[edge.to];

			const position: Position = fromPosition && toPosition ? { x: (fromPosition.x + toPosition.x) / 2, y: (fromPosition.y + toPosition.y) / 2 } : { x: 0, y: 0 };

			mutateDefinition((definition) => ({
				...definition,
				nodes: [...definition.nodes, node],
				edges: [...definition.edges.filter((graphEdge) => !(graphEdge.from === edge.from && graphEdge.to === edge.to)), { from: edge.from, to: id }, { from: id, to: edge.to }],
			}));

			graphStore.mutate(graph, (proxy) => {
				proxy.positions[id] = { x: position.x, y: position.y };
			});

			pushHistory({
				label: `Insert ${nodeName} on edge`,
				undo: () => {
					const current = contextRef.current;

					current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.filter((node) => node.id !== id),
						edges: [
							...definition.edges.filter((graphEdge) => !(graphEdge.from === edge.from && graphEdge.to === id) && !(graphEdge.from === id && graphEdge.to === edge.to)),
							{ from: edge.from, to: edge.to },
						],
					}));
					current.graphStore.mutate(current.graph, (proxy) => {
						const { [id]: _removedPosition, ...remainingPositions } = proxy.positions;

						proxy.positions = remainingPositions;
					});
				},
				redo: () => {
					const current = contextRef.current;

					current.mutateDefinition((definition) => ({
						...definition,
						nodes: [...definition.nodes, node],
						edges: [...definition.edges.filter((graphEdge) => !(graphEdge.from === edge.from && graphEdge.to === edge.to)), { from: edge.from, to: id }, { from: id, to: edge.to }],
					}));
					current.graphStore.mutate(current.graph, (proxy) => {
						proxy.positions[id] = { x: position.x, y: position.y };
					});
				},
			});
		}

		function toggleBypass(nodeId: string): void {
			const { graphDefinition, mutateDefinition, pushHistory } = contextRef.current;
			const currentNode = graphDefinition.nodes.find((node) => node.id === nodeId);
			const wasBypassed = currentNode?.options?.bypass ?? false;

			mutateDefinition((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, options: { ...node.options, bypass: !wasBypassed } } : node)),
			}));

			pushHistory({
				label: `${wasBypassed ? "Enable" : "Bypass"} node`,
				undo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, options: { ...node.options, bypass: wasBypassed } } : node)),
					}));
				},
				redo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) => (node.id === nodeId ? { ...node, options: { ...node.options, bypass: !wasBypassed } } : node)),
					}));
				},
			});
		}

		function setGraphName(name: string): void {
			const { graphDefinition, mutateDefinition, pushHistory } = contextRef.current;
			const previousName = graphDefinition.name;

			mutateDefinition((definition) => ({
				...definition,
				name,
			}));

			pushHistory({
				label: `Rename graph to "${name}"`,
				undo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						name: previousName,
					}));
				},
				redo: () => {
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						name,
					}));
				},
			});
		}

		// ------------------------------------------------------------------
		// Nested path helpers
		// ------------------------------------------------------------------

		/**
		 * Deep-clone a plain JSON value.
		 * Only handles the subset produced by BAG parameters: objects, arrays, primitives.
		 */
		function deepClone(value: unknown): unknown {
			if (value === null || typeof value !== "object") return value;

			if (Array.isArray(value)) return value.map(deepClone);

			const cloned: Record<string, unknown> = {};

			for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
				cloned[key] = deepClone(fieldValue);
			}

			return cloned;
		}

		/**
		 * Return a deep-cloned copy of `root` with the nested location
		 * described by `subPath` set to `newValue`.
		 * `subPath` is the path after the top-level parameter name.
		 */
		function withNestedValue(
			root: unknown,
			subPath: ReadonlyArray<string | number>,
			newValue: unknown,
		): unknown {
			if (subPath.length === 0) return newValue;

			const head = subPath[0];
			const tail = subPath.slice(1);

			if (typeof head === "number") {
				const arr: Array<unknown> = Array.isArray(root) ? [...(root as Array<unknown>)] : [];

				arr[head] = withNestedValue(arr[head], tail, newValue);

				return arr;
			}

			if (typeof head === "string") {
				const record = root !== null && typeof root === "object" && !Array.isArray(root)
					? { ...(root as Record<string, unknown>) }
					: {};

				record[head] = withNestedValue(record[head], tail, newValue);

				return record;
			}

			return root;
		}

		function setParameterAtPath(nodeId: string, path: ReadonlyArray<string | number>, value: unknown): void {
			if (path.length === 0) return;

			const { graphDefinition, mutateDefinition, pushHistory } = contextRef.current;
			const currentNode = graphDefinition.nodes.find((node) => node.id === nodeId);
			const topLevelName = path[0];

			if (typeof topLevelName !== "string") return;

			const subPath = path.slice(1);
			const previousTopValue = deepClone(currentNode?.parameters?.[topLevelName]);
			const newTopValue = withNestedValue(previousTopValue, subPath, value);

			mutateDefinition((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.id === nodeId
						? { ...node, parameters: { ...node.parameters, [topLevelName]: newTopValue } }
						: node,
				),
			}));

			pushHistory({
				label: `Change ${topLevelName}`,
				undo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [topLevelName]: previousTopValue } }
								: node,
						),
					})),
				redo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [topLevelName]: newTopValue } }
								: node,
						),
					})),
			});
		}

		function addArrayRow(nodeId: string, paramName: string, defaultItem: Record<string, unknown>): void {
			const { graphDefinition, mutateDefinition, pushHistory } = contextRef.current;
			const currentNode = graphDefinition.nodes.find((node) => node.id === nodeId);
			const previousArray = Array.isArray(currentNode?.parameters?.[paramName])
				? [...(currentNode.parameters[paramName] as Array<unknown>)]
				: [];
			const newArray = [...previousArray, defaultItem];

			mutateDefinition((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.id === nodeId
						? { ...node, parameters: { ...node.parameters, [paramName]: newArray } }
						: node,
				),
			}));

			pushHistory({
				label: `Add ${paramName} row`,
				undo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [paramName]: previousArray } }
								: node,
						),
					})),
				redo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [paramName]: newArray } }
								: node,
						),
					})),
			});
		}

		function deleteArrayRow(nodeId: string, paramName: string, rowIndex: number): void {
			const { graphDefinition, mutateDefinition, pushHistory } = contextRef.current;
			const currentNode = graphDefinition.nodes.find((node) => node.id === nodeId);
			const previousArray = Array.isArray(currentNode?.parameters?.[paramName])
				? [...(currentNode.parameters[paramName] as Array<unknown>)]
				: [];
			const newArray = previousArray.filter((_, index) => index !== rowIndex);

			mutateDefinition((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.id === nodeId
						? { ...node, parameters: { ...node.parameters, [paramName]: newArray } }
						: node,
				),
			}));

			pushHistory({
				label: `Delete ${paramName} row`,
				undo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [paramName]: previousArray } }
								: node,
						),
					})),
				redo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [paramName]: newArray } }
								: node,
						),
					})),
			});
		}

		function reorderArrayRows(nodeId: string, paramName: string, fromIndex: number, toIndex: number): void {
			const { graphDefinition, mutateDefinition, pushHistory } = contextRef.current;
			const currentNode = graphDefinition.nodes.find((node) => node.id === nodeId);
			const previousArray = Array.isArray(currentNode?.parameters?.[paramName])
				? [...(currentNode.parameters[paramName] as Array<unknown>)]
				: [];

			if (fromIndex < 0 || fromIndex >= previousArray.length || toIndex < 0 || toIndex >= previousArray.length) {
				return;
			}

			const newArray = [...previousArray];
			const [moved] = newArray.splice(fromIndex, 1);

			newArray.splice(toIndex, 0, moved);

			mutateDefinition((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.id === nodeId
						? { ...node, parameters: { ...node.parameters, [paramName]: newArray } }
						: node,
				),
			}));

			pushHistory({
				label: `Reorder ${paramName} rows`,
				undo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [paramName]: previousArray } }
								: node,
						),
					})),
				redo: () =>
					contextRef.current.mutateDefinition((definition) => ({
						...definition,
						nodes: definition.nodes.map((node) =>
							node.id === nodeId
								? { ...node, parameters: { ...node.parameters, [paramName]: newArray } }
								: node,
						),
					})),
			});
		}

		return {
			addNode,
			removeNode,
			addEdge,
			removeEdge,
			insertNodeOnEdge,
			toggleBypass,
			setGraphName,
			setParameterAtPath,
			addArrayRow,
			deleteArrayRow,
			reorderArrayRows,
		};
	}, []);
}
