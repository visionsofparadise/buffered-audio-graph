import type { GraphEdge, GraphNode } from "@buffered-audio/core";
import { useMemo, useRef } from "react";
import type { GraphContext } from "../../../../models/Context";
import type { Mutable } from "../../../../models/State";
import type { GraphDefinitionState } from "../../../../models/State/GraphDefinition";
import { buildDefaultParameters } from "../Node/utils/buildParameters";
import { lookupNode } from "../Node/utils/nodeLookup";

interface Position {
	x: number;
	y: number;
}

interface GraphMutations {
	addNode: (packageName: string, nodeName: string, position: Position) => void;
	removeNode: (nodeId: string) => void;
	addEdge: (from: string, to: string) => void;
	removeEdge: (from: string, to: string) => void;
	insertNodeOnEdge: (edge: GraphEdge, packageName: string, nodeName: string) => void;
	toggleBypass: (nodeId: string) => void;
	/** Reset every parameter of a node to its schema default as one history entry. */
	resetNodeParameters: (nodeId: string) => void;
	setGraphName: (name: string) => void;
	/** Set a nested parameter value at a path. path[0] is the top-level parameter name. */
	setParameterAtPath: (nodeId: string, path: ReadonlyArray<string | number>, value: unknown) => void;
	/** Delete a nested parameter key at a path — used to return an optional param to AUTO (unset). */
	deleteParameterAtPath: (nodeId: string, path: ReadonlyArray<string | number>) => void;
	/** Append a new item (plain JSON object) to an array parameter. */
	addArrayRow: (nodeId: string, paramName: string, defaultItem: Record<string, unknown>) => void;
	/** Remove an item from an array parameter by index. */
	deleteArrayRow: (nodeId: string, paramName: string, rowIndex: number) => void;
	/** Move an item in an array parameter from one index to another. */
	reorderArrayRows: (nodeId: string, paramName: string, fromIndex: number, toIndex: number) => void;
}

/**
 * Write `value` at `path` into `root`, creating intermediate plain
 * objects/arrays where the path does not yet exist. Mutates `root` in place.
 */
function setNestedValue(
	root: Record<string | number, unknown>,
	path: ReadonlyArray<string | number>,
	value: unknown,
): void {
	let container: Record<string | number, unknown> = root;

	for (let depth = 0; depth < path.length - 1; depth++) {
		const key = path[depth];
		const nextKey = path[depth + 1];

		if (key === undefined) return;

		const existing = container[key];

		if (existing === null || typeof existing !== "object") {
			container[key] = typeof nextKey === "number" ? [] : {};
		}

		container = container[key] as Record<string | number, unknown>;
	}

	const leaf = path[path.length - 1];

	if (leaf === undefined) return;

	container[leaf] = value;
}

/**
 * Delete the leaf key at `path` from `root`. Walks to the parent container; if
 * any intermediate is missing, no-ops. Mutates `root` in place.
 */
function deleteNestedValue(
	root: Record<string | number, unknown>,
	path: ReadonlyArray<string | number>,
): void {
	let container: Record<string | number, unknown> = root;

	for (let depth = 0; depth < path.length - 1; depth++) {
		const key = path[depth];

		if (key === undefined) return;

		const existing = container[key];

		if (existing === null || typeof existing !== "object") return;

		container = existing as Record<string | number, unknown>;
	}

	const leaf = path[path.length - 1];

	if (leaf === undefined) return;

	Reflect.deleteProperty(container, leaf);
}

export function useGraphMutations(context: GraphContext): GraphMutations {
	const contextRef = useRef(context);

	contextRef.current = context;

	return useMemo<GraphMutations>(() => {
		function mutate(callback: (proxy: Mutable<GraphDefinitionState>) => void, transactionKey?: string): void {
			const { history, graphDefinition } = contextRef.current;

			history.mutate(graphDefinition, callback, transactionKey ? { transactionKey } : undefined);
		}

		/**
		 * Resolve the version a newly-added node binds to: the bag's `packages`
		 * pin when present, else the latest installed ready version (which the
		 * caller then writes into the map). Returns null when no version of the
		 * package is installed.
		 */
		function resolveAddVersion(packageName: string): string | null {
			const { graphDefinition, app } = contextRef.current;
			const pinned = graphDefinition.packages[packageName];

			if (typeof pinned === "string") return pinned;

			const ready = app.packages.filter(
				(entry) => entry.name === packageName && entry.status === "ready" && entry.version !== null,
			);

			if (ready.length === 0) return null;

			const latest = ready.reduce((winner, candidate) =>
				(candidate.version ?? "").localeCompare(winner.version ?? "", undefined, { numeric: true, sensitivity: "base" }) > 0
					? candidate
					: winner,
			);

			return latest.version;
		}

		function addNode(packageName: string, nodeName: string, position: Position): void {
			const { graphStore, graph, graphDefinition, app, logger } = contextRef.current;

			const version = resolveAddVersion(packageName);

			if (version === null) {
				logger.error(`Cannot add node "${nodeName}": no installed version of ${packageName}`, undefined, { namespace: "graph" });

				return;
			}

			const bagApiVersion = graphDefinition.apiVersion;
			const packageEntry = app.packages.find((entry) => entry.name === packageName && entry.version === version);
			const packageApiVersion = packageEntry?.apiVersion ?? null;

			if (packageApiVersion !== null && packageApiVersion !== bagApiVersion) {
				logger.error(
					`Cannot add node "${nodeName}": package ${packageName}@${version} is on API version ${String(packageApiVersion)} but the bag is on API version ${String(bagApiVersion)}`,
					undefined,
					{ namespace: "graph" },
				);

				return;
			}

			const id = crypto.randomUUID();

			const node: GraphNode = {
				id,
				packageName,
				nodeName,
				parameters: {},
			};

			mutate((proxy) => {
				proxy.packages = { ...proxy.packages, [packageName]: version };
				proxy.nodes = [...proxy.nodes, node];
			});

			graphStore.mutate(graph, (proxy) => {
				proxy.positions[id] = { x: position.x, y: position.y };
			});
		}

		function removeNode(nodeId: string): void {
			mutate((proxy) => {
				proxy.nodes = proxy.nodes.filter((node) => node.id !== nodeId);
				proxy.edges = proxy.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
			});

			const { graphStore, graph } = contextRef.current;

			graphStore.mutate(graph, (proxy) => {
				const { [nodeId]: _removedPosition, ...remainingPositions } = proxy.positions;

				proxy.positions = remainingPositions;
			});
		}

		function addEdge(from: string, to: string): void {
			mutate((proxy) => {
				proxy.edges = [...proxy.edges, { from, to }];
			});
		}

		function removeEdge(from: string, to: string): void {
			mutate((proxy) => {
				proxy.edges = proxy.edges.filter((edge) => !(edge.from === from && edge.to === to));
			});
		}

		function insertNodeOnEdge(edge: GraphEdge, packageName: string, nodeName: string): void {
			const { graph, graphStore, logger } = contextRef.current;

			const version = resolveAddVersion(packageName);

			if (version === null) {
				logger.error(`Cannot insert node "${nodeName}": no installed version of ${packageName}`, undefined, { namespace: "graph" });

				return;
			}

			const id = crypto.randomUUID();

			const node: GraphNode = {
				id,
				packageName,
				nodeName,
				parameters: {},
			};

			const fromPosition = graph.positions[edge.from];
			const toPosition = graph.positions[edge.to];
			const position: Position = fromPosition && toPosition
				? { x: (fromPosition.x + toPosition.x) / 2, y: (fromPosition.y + toPosition.y) / 2 }
				: { x: 0, y: 0 };

			mutate((proxy) => {
				proxy.packages = { ...proxy.packages, [packageName]: version };
				proxy.nodes = [...proxy.nodes, node];
				proxy.edges = [
					...proxy.edges.filter((graphEdge) => !(graphEdge.from === edge.from && graphEdge.to === edge.to)),
					{ from: edge.from, to: id },
					{ from: id, to: edge.to },
				];
			});

			graphStore.mutate(graph, (proxy) => {
				proxy.positions[id] = { x: position.x, y: position.y };
			});
		}

		function toggleBypass(nodeId: string): void {
			mutate((proxy) => {
				const node = proxy.nodes.find((graphNode) => graphNode.id === nodeId);

				if (!node) return;

				const current = node.options?.bypass ?? false;

				node.options = { ...node.options, bypass: !current };
			});
		}

		function resetNodeParameters(nodeId: string): void {
			const { graphDefinition } = contextRef.current;
			const graphNode = graphDefinition.nodes.find((node) => node.id === nodeId);

			if (!graphNode) return;

			const version = graphDefinition.packages[graphNode.packageName] ?? "";
			const { schema } = lookupNode(graphNode.packageName, version, graphNode.nodeName, contextRef.current);
			const defaults = buildDefaultParameters(schema);

			mutate((proxy) => {
				const node = proxy.nodes.find((candidate) => candidate.id === nodeId);

				if (!node) return;

				node.parameters = defaults;
			});
		}

		function setGraphName(name: string): void {
			mutate((proxy) => {
				proxy.name = name;
			});
		}

		function setParameterAtPath(nodeId: string, path: ReadonlyArray<string | number>, value: unknown): void {
			if (path.length === 0) return;

			if (typeof path[0] !== "string") return;

			mutate((proxy) => {
				const node = proxy.nodes.find((candidate) => candidate.id === nodeId);

				if (!node) return;

				node.parameters ??= {};

				setNestedValue(node.parameters, path, value);
			});
		}

		function deleteParameterAtPath(nodeId: string, path: ReadonlyArray<string | number>): void {
			if (path.length === 0) return;

			if (typeof path[0] !== "string") return;

			mutate((proxy) => {
				const node = proxy.nodes.find((candidate) => candidate.id === nodeId);

				if (!node?.parameters) return;

				deleteNestedValue(node.parameters, path);
			});
		}

		function addArrayRow(nodeId: string, paramName: string, defaultItem: Record<string, unknown>): void {
			mutate((proxy) => {
				const node = proxy.nodes.find((candidate) => candidate.id === nodeId);

				if (!node) return;

				node.parameters ??= {};

				const existing = node.parameters[paramName];
				const rows = Array.isArray(existing) ? (existing as Array<unknown>) : [];

				node.parameters[paramName] = [...rows, defaultItem];
			});
		}

		function deleteArrayRow(nodeId: string, paramName: string, rowIndex: number): void {
			mutate((proxy) => {
				const node = proxy.nodes.find((candidate) => candidate.id === nodeId);

				if (!node?.parameters) return;

				const existing = node.parameters[paramName];

				if (!Array.isArray(existing)) return;

				const rows = existing as Array<unknown>;

				if (rowIndex < 0 || rowIndex >= rows.length) return;

				node.parameters[paramName] = rows.filter((_, index) => index !== rowIndex);
			});
		}

		function reorderArrayRows(nodeId: string, paramName: string, fromIndex: number, toIndex: number): void {
			mutate((proxy) => {
				const node = proxy.nodes.find((candidate) => candidate.id === nodeId);

				if (!node?.parameters) return;

				const existing = node.parameters[paramName];

				if (!Array.isArray(existing)) return;

				const rows = [...(existing as Array<unknown>)];

				if (fromIndex < 0 || fromIndex >= rows.length || toIndex < 0 || toIndex >= rows.length) return;

				const [moved] = rows.splice(fromIndex, 1);

				rows.splice(toIndex, 0, moved);
				node.parameters[paramName] = rows;
			});
		}

		return {
			addNode,
			removeNode,
			addEdge,
			removeEdge,
			insertNodeOnEdge,
			toggleBypass,
			resetNodeParameters,
			setGraphName,
			setParameterAtPath,
			deleteParameterAtPath,
			addArrayRow,
			deleteArrayRow,
			reorderArrayRows,
		};
	}, []);
}
