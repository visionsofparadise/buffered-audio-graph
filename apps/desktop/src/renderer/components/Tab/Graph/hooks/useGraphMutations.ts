import type { GraphDefinition, GraphEdge, GraphNode } from "@buffered-audio/core";
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
 * Return a deep-cloned copy of `root` with the nested location described by
 * `subPath` set to `newValue`. `subPath` is the path after the top-level
 * parameter name.
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

export function useGraphMutations(context: GraphContext): GraphMutations {
	const contextRef = useRef(context);

	contextRef.current = context;

	return useMemo<GraphMutations>(() => {
		function mutate(
			updater: (definition: GraphDefinition) => GraphDefinition,
			transactionKey?: string,
		): void {
			const { history, graphDefinition, mutateDefinition } = contextRef.current;

			history.mutate(
				graphDefinition,
				() => {
					mutateDefinition(updater);
				},
				transactionKey ? { transactionKey } : undefined,
			);
		}

		function addNode(packageName: string, packageVersion: string, nodeName: string, position: Position): void {
			const { graphStore, graph } = contextRef.current;
			const id = crypto.randomUUID();

			const node: GraphNode = {
				id,
				packageName,
				packageVersion,
				nodeName,
				parameters: {},
			};

			mutate((definition) => ({
				...definition,
				nodes: [...definition.nodes, node],
			}));

			graphStore.mutate(graph, (proxy) => {
				proxy.positions[id] = { x: position.x, y: position.y };
			});
		}

		function removeNode(nodeId: string): void {
			mutate((definition) => ({
				...definition,
				nodes: definition.nodes.filter((node) => node.id !== nodeId),
				edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
			}));

			const { graphStore, graph } = contextRef.current;

			graphStore.mutate(graph, (proxy) => {
				const { [nodeId]: _removedPosition, ...remainingPositions } = proxy.positions;

				proxy.positions = remainingPositions;
			});
		}

		function addEdge(from: string, to: string): void {
			mutate((definition) => ({
				...definition,
				edges: [...definition.edges, { from, to }],
			}));
		}

		function removeEdge(from: string, to: string): void {
			mutate((definition) => ({
				...definition,
				edges: definition.edges.filter((edge) => !(edge.from === from && edge.to === to)),
			}));
		}

		function insertNodeOnEdge(edge: GraphEdge, packageName: string, packageVersion: string, nodeName: string): void {
			const { graph, graphStore } = contextRef.current;
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
			const position: Position = fromPosition && toPosition
				? { x: (fromPosition.x + toPosition.x) / 2, y: (fromPosition.y + toPosition.y) / 2 }
				: { x: 0, y: 0 };

			mutate((definition) => ({
				...definition,
				nodes: [...definition.nodes, node],
				edges: [
					...definition.edges.filter((graphEdge) => !(graphEdge.from === edge.from && graphEdge.to === edge.to)),
					{ from: edge.from, to: id },
					{ from: id, to: edge.to },
				],
			}));

			graphStore.mutate(graph, (proxy) => {
				proxy.positions[id] = { x: position.x, y: position.y };
			});
		}

		function toggleBypass(nodeId: string): void {
			mutate((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) =>
					node.id === nodeId
						? { ...node, options: { ...node.options, bypass: !(node.options?.bypass ?? false) } }
						: node,
				),
			}));
		}

		function setGraphName(name: string): void {
			mutate((definition) => ({
				...definition,
				name,
			}));
		}

		function setParameterAtPath(nodeId: string, path: ReadonlyArray<string | number>, value: unknown): void {
			if (path.length === 0) return;

			const topLevelName = path[0];

			if (typeof topLevelName !== "string") return;

			const subPath = path.slice(1);

			mutate((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) => {
					if (node.id !== nodeId) return node;

					const previousTopValue = deepClone(node.parameters?.[topLevelName]);
					const newTopValue = withNestedValue(previousTopValue, subPath, value);

					return { ...node, parameters: { ...node.parameters, [topLevelName]: newTopValue } };
				}),
			}));
		}

		function addArrayRow(nodeId: string, paramName: string, defaultItem: Record<string, unknown>): void {
			mutate((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) => {
					if (node.id !== nodeId) return node;

					const previousArray = Array.isArray(node.parameters?.[paramName])
						? [...(node.parameters[paramName] as Array<unknown>)]
						: [];

					return {
						...node,
						parameters: { ...node.parameters, [paramName]: [...previousArray, defaultItem] },
					};
				}),
			}));
		}

		function deleteArrayRow(nodeId: string, paramName: string, rowIndex: number): void {
			mutate((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) => {
					if (node.id !== nodeId) return node;

					const previousArray = Array.isArray(node.parameters?.[paramName])
						? [...(node.parameters[paramName] as Array<unknown>)]
						: [];

					return {
						...node,
						parameters: {
							...node.parameters,
							[paramName]: previousArray.filter((_, index) => index !== rowIndex),
						},
					};
				}),
			}));
		}

		function reorderArrayRows(nodeId: string, paramName: string, fromIndex: number, toIndex: number): void {
			mutate((definition) => ({
				...definition,
				nodes: definition.nodes.map((node) => {
					if (node.id !== nodeId) return node;

					const previousArray = Array.isArray(node.parameters?.[paramName])
						? [...(node.parameters[paramName] as Array<unknown>)]
						: [];

					if (fromIndex < 0 || fromIndex >= previousArray.length || toIndex < 0 || toIndex >= previousArray.length) {
						return node;
					}

					const next = [...previousArray];
					const [moved] = next.splice(fromIndex, 1);

					next.splice(toIndex, 0, moved);

					return { ...node, parameters: { ...node.parameters, [paramName]: next } };
				}),
			}));
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
