import type { GraphDefinition } from "@buffered-audio/core";
import { useEffect, useMemo } from "react";
import { useGraphState } from "../../../hooks/useGraphState";
import { useHistory } from "../../../hooks/useHistory";
import type { AppContext, GraphContext } from "../../../models/Context";
import { ProxyStore } from "../../../models/ProxyStore/ProxyStore";
import type { TabEntry } from "../../../models/State/App";
import type { GraphState } from "../../../models/State/Graph";
import { ReactFlowProvider } from "@xyflow/react";
import { computeAutoLayout } from "../../../utilities/autoLayout";
import { importBag } from "../../../utilities/bagOperations";
import { mergeImportedBag } from "../../../utilities/importBag";
import { GraphCanvas } from "./Canvas";

interface Props {
	readonly initialGraphState: Omit<GraphState, "_key">;
	readonly context: AppContext;
	readonly tab: TabEntry;
	readonly graphDefinition: GraphDefinition;
	readonly mutateDefinition: (updater: (definition: GraphDefinition) => GraphDefinition) => void;
}

export function GraphSession({ initialGraphState, context, tab, graphDefinition, mutateDefinition }: Props) {
	const graphStore = useMemo(() => new ProxyStore(), []);

	// Apply auto-layout to initial state if no positions saved
	const layoutAppliedState = useMemo(() => {
		const needsLayout = Object.keys(initialGraphState.positions).length === 0 && graphDefinition.nodes.length > 0;

		return needsLayout ? { ...initialGraphState, positions: computeAutoLayout(graphDefinition.nodes, graphDefinition.edges) } : initialGraphState;
	}, [initialGraphState, graphDefinition.nodes, graphDefinition.edges]);

	const { graph } = useGraphState(layoutAppliedState, graphStore, tab.id, context);

	const { history, pushHistory, undo, redo } = useHistory(tab.id, context);

	// Sync tab name from graph definition
	useEffect(() => {
		context.tabNames.set(tab.id, graphDefinition.name);
	}, [context.tabNames, tab.id, graphDefinition.name]);

	// Register rename callback so TabBar can rename this graph
	useEffect(() => {
		context.renameCallbacks.set(tab.id, (name: string) => {
			mutateDefinition((definition) => ({
				...definition,
				name,
			}));
		});

		return () => {
			context.renameCallbacks.delete(tab.id);
		};
	}, [context.renameCallbacks, tab.id, mutateDefinition]);

	useEffect(() => {
		context.undoCallbacks.set(tab.id, undo);
		context.redoCallbacks.set(tab.id, redo);

		return () => {
			context.undoCallbacks.delete(tab.id);
			context.redoCallbacks.delete(tab.id);
		};
	}, [context.undoCallbacks, context.redoCallbacks, tab.id, undo, redo]);

	useEffect(() => {
		context.importCallbacks.set(tab.id, async () => {
			const imported = await importBag(context.main);

			if (!imported) return;

			const previousDefinition = structuredClone(graphDefinition);
			const previousPositions = structuredClone(graph.positions);
			const merged = mergeImportedBag({
				currentDefinition: previousDefinition,
				currentPositions: previousPositions,
				importedDefinition: imported.definition,
			});

			if (merged.importedNodeCount === 0) return;

			const nextDefinition = structuredClone(merged.definition);
			const nextPositions = structuredClone(merged.positions);

			mutateDefinition(() => nextDefinition);
			graphStore.mutate(graph, (proxy) => {
				proxy.positions = nextPositions;
			});

			pushHistory({
				label: `Import ${imported.definition.name}`,
				undo: () => {
					mutateDefinition(() => previousDefinition);
					graphStore.mutate(graph, (proxy) => {
						proxy.positions = structuredClone(previousPositions);
					});
				},
				redo: () => {
					mutateDefinition(() => nextDefinition);
					graphStore.mutate(graph, (proxy) => {
						proxy.positions = structuredClone(nextPositions);
					});
				},
			});
		});

		return () => {
			context.importCallbacks.delete(tab.id);
		};
	}, [context.importCallbacks, context.main, tab.id, graphDefinition, graph.positions, graph, graphStore, mutateDefinition, pushHistory]);

	const graphContext: GraphContext = useMemo(
		() => ({
			...context,
			graph,
			graphStore,
			graphDefinition,
			mutateDefinition,
			bagPath: tab.bagPath,
			bagId: tab.id,
			history,
			pushHistory,
			undo,
			redo,
		}),
		[context, graph, graphStore, graphDefinition, mutateDefinition, tab.bagPath, tab.id, history, pushHistory, undo, redo],
	);

	return (
		<ReactFlowProvider>
			<GraphCanvas context={graphContext} />
		</ReactFlowProvider>
	);
}
