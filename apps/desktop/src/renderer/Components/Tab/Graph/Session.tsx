import { ReactFlowProvider } from "@xyflow/react";
import { batch, identify, subscribe } from "opshot";
import { useMutableState } from "opshot/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureGraphPackagesInstalled } from "../../../hooks/packagePipeline";
import { useGraphDefinition } from "../../../hooks/useGraphDefinition";
import { useGraphState } from "../../../hooks/useGraphState";
import { createHistory } from "../../../Models/History";
import { computeAutoLayout } from "../../../utils/autoLayout";
import { importBag } from "../../../utils/bagOperations";
import { mergeImportedBag } from "../../../utils/importBag";
import { GraphCanvas } from "./Canvas";
import type { AppContext, GraphContext } from "../../../Models/Context";
import type { GraphMeta } from "../../../Models/History";
import type { TabEntry } from "../../../Models/State/App";
import type { GraphState } from "../../../Models/State/Graph";
import type { GraphDefinitionState } from "../../../Models/State/GraphDefinition";
import type { GraphDefinition } from "@buffered-audio/core";

interface Props {
	readonly initialGraphState: GraphState;
	readonly initialDefinition: GraphDefinitionState;
	readonly initialContent: string;
	readonly tab: TabEntry;
	readonly context: AppContext;
}

export function GraphSession({ initialGraphState, initialDefinition, initialContent, tab, context }: Props) {
	const seededPositions = useMemo(() => {
		const needsLayout = Object.keys(initialGraphState.positions).length === 0 && initialDefinition.nodes.length > 0;

		return needsLayout
			? computeAutoLayout(initialDefinition.nodes, initialDefinition.edges)
			: initialGraphState.positions;
	}, [initialGraphState, initialDefinition]);

	const graphDefinition = useMutableState(initialDefinition);
	const positions = useMutableState({ positions: seededPositions });
	const [history] = useState(() => createHistory([graphDefinition, positions]));

	const { flushDefinition } = useGraphDefinition(graphDefinition, initialContent, tab.bagPath, context);

	useGraphState(positions, tab.id, context);

	useEffect(() => {
		context.tabNames.names[tab.id] = graphDefinition.name;
	}, [identify(context.tabNames), tab.id, graphDefinition.name]);

	const onSave = useCallback(() => {
		flushDefinition();
	}, [flushDefinition]);

	const { activeCommands } = context;

	useEffect(() => {
		const rename = (name: string) => {
			graphDefinition.name = name;
		};

		const importBagCommand = async () => {
			const imported = await importBag(context.main);

			if (!imported) return;

			const previousDefinition = JSON.parse(
				JSON.stringify({
					id: graphDefinition.id,
					apiVersion: graphDefinition.apiVersion,
					name: graphDefinition.name,
					nodes: graphDefinition.nodes,
					edges: graphDefinition.edges,
				}),
			) as GraphDefinition;
			const previousPositions = JSON.parse(JSON.stringify(positions.positions)) as Record<
				string,
				{ x: number; y: number }
			>;

			let merged;

			try {
				merged = mergeImportedBag({
					currentDefinition: previousDefinition,
					currentPositions: previousPositions,
					importedDefinition: imported.definition,
				});
			} catch (error) {
				context.logger.error("Bag import failed", error as Error, { namespace: "graph" });

				return;
			}

			if (merged.importedNodeCount === 0) return;

			const transactionKey = crypto.randomUUID();

			batch(
				() => {
					graphDefinition.nodes = merged.definition.nodes;
					graphDefinition.edges = merged.definition.edges;
					positions.positions = merged.positions;
				},
				{ transactionKey } satisfies GraphMeta,
			);

			if (context.app.installBagPackagesAutomatically) {
				try {
					await ensureGraphPackagesInstalled(merged.definition, context.app, context.main);
				} catch (error) {
					context.logger.error("Failed to install packages required by imported bag", error as Error, {
						namespace: "packages",
					});
				}
			}
		};

		activeCommands.undo = () => history.undo();
		activeCommands.redo = () => history.redo();
		activeCommands.canUndo = history.canUndo;
		activeCommands.canRedo = history.canRedo;
		activeCommands.rename = rename;
		activeCommands.importBag = importBagCommand;
		activeCommands.save = onSave;

		const unsubscribe = subscribe(history, () => {
			activeCommands.canUndo = history.canUndo;
			activeCommands.canRedo = history.canRedo;
		});

		return () => {
			unsubscribe();

			activeCommands.undo = null;
			activeCommands.redo = null;
			activeCommands.canUndo = false;
			activeCommands.canRedo = false;
			activeCommands.rename = null;
			activeCommands.importBag = null;
			activeCommands.save = null;
		};
	}, [identify(activeCommands), context.main, history, identify(graphDefinition), identify(positions), onSave]);

	const graphContext: GraphContext = useMemo(
		() => ({
			...context,
			graphDefinition,
			positions,
			history,
			flushDefinition,
			bagPath: tab.bagPath,
			bagId: tab.id,
			onSave,
		}),
		[context, identify(graphDefinition), identify(positions), history, flushDefinition, tab.bagPath, tab.id, onSave],
	);

	return (
		<ReactFlowProvider>
			<GraphCanvas context={graphContext} />
		</ReactFlowProvider>
	);
}
