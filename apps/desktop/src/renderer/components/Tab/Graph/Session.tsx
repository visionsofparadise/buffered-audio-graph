import type { GraphDefinition } from "@buffered-audio/core";
import { ReactFlowProvider } from "@xyflow/react";
import { useCallback, useEffect, useMemo } from "react";
import { useSnapshot } from "valtio";
import { useGraphDefinition } from "../../../hooks/useGraphDefinition";
import { useGraphState } from "../../../hooks/useGraphState";
import type { AppContext, GraphContext } from "../../../models/Context";
import type { ProxyStore } from "../../../models/ProxyStore/ProxyStore";
import type { TabEntry } from "../../../models/State/App";
import type { GraphState } from "../../../models/State/Graph";
import type { GraphDefinitionState } from "../../../models/State/GraphDefinition";
import { createHistory, type History } from "../../../models/State/History";
import { computeAutoLayout } from "../../../utils/autoLayout";
import { importBag } from "../../../utils/bagOperations";
import { mergeImportedBag } from "../../../utils/importBag";
import { GraphCanvas } from "./Canvas";

interface Props {
	readonly initialGraphState: Omit<GraphState, "_key">;
	readonly initialDefinition: Omit<GraphDefinitionState, "_key">;
	readonly initialContent: string;
	readonly tab: TabEntry;
	readonly graphStore: ProxyStore;
	readonly context: AppContext;
}

export function GraphSession({ initialGraphState, initialDefinition, initialContent, tab, graphStore, context }: Props) {
	const { graphDefinition, mutateDefinition } = useGraphDefinition(initialDefinition, initialContent, graphStore, tab.bagPath, context);

	const layoutAppliedState = useMemo(() => {
		const needsLayout = Object.keys(initialGraphState.positions).length === 0 && graphDefinition.nodes.length > 0;

		return needsLayout
			? { ...initialGraphState, positions: computeAutoLayout(graphDefinition.nodes, graphDefinition.edges) }
			: initialGraphState;
	}, [initialGraphState, graphDefinition.nodes, graphDefinition.edges]);

	const { graph } = useGraphState(layoutAppliedState, graphStore, tab.id, context);

	const historyProxy = useMemo<History>(() => createHistory(graphStore), [graphStore]);
	const history = useSnapshot(historyProxy);

	useEffect(() => {
		context.tabNames.set(tab.id, graphDefinition.name);
	}, [context.tabNames, tab.id, graphDefinition.name]);

	const onSave = useCallback(() => {
		mutateDefinition.flush();
	}, [mutateDefinition]);

	useEffect(() => {
		const rename = (name: string) => {
			mutateDefinition((definition) => ({
				...definition,
				name,
			}));
		};

		const importBagCommand = async () => {
			const imported = await importBag(context.main);

			if (!imported) return;

			const previousDefinition: GraphDefinition = structuredClone({
				id: graphDefinition.id,
				name: graphDefinition.name,
				nodes: graphDefinition.nodes as GraphDefinition["nodes"],
				edges: graphDefinition.edges as GraphDefinition["edges"],
			});
			const previousPositions = structuredClone(graph.positions);
			const merged = mergeImportedBag({
				currentDefinition: previousDefinition,
				currentPositions: previousPositions,
				importedDefinition: imported.definition,
			});

			if (merged.importedNodeCount === 0) return;

			const nextDefinition = structuredClone(merged.definition);
			const nextPositions = structuredClone(merged.positions);

			history.mutate(graphDefinition, () => {
				mutateDefinition(() => nextDefinition);
			});

			graphStore.mutate(graph, (proxy) => {
				proxy.positions = nextPositions;
			});
		};

		context.appStore.mutate(context.activeCommands, (proxy) => {
			proxy.undo = () => history.undo();
			proxy.redo = () => history.redo();
			proxy.canUndo = history.canUndo;
			proxy.canRedo = history.canRedo;
			proxy.rename = rename;
			proxy.importBag = importBagCommand;
			proxy.save = onSave;
		});

		return () => {
			context.appStore.mutate(context.activeCommands, (proxy) => {
				proxy.undo = null;
				proxy.redo = null;
				proxy.canUndo = false;
				proxy.canRedo = false;
				proxy.rename = null;
				proxy.importBag = null;
				proxy.save = null;
			});
		};
	}, [
		context.appStore,
		context.activeCommands,
		context.main,
		history,
		mutateDefinition,
		graphDefinition,
		graph,
		graph.positions,
		graphStore,
		onSave,
	]);

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
			onSave,
		}),
		[context, graph, graphStore, graphDefinition, mutateDefinition, tab.bagPath, tab.id, history, onSave],
	);

	return (
		<ReactFlowProvider>
			<GraphCanvas context={graphContext} />
		</ReactFlowProvider>
	);
}
