import type { GraphDefinition } from "@buffered-audio/core";
import { ReactFlowProvider } from "@xyflow/react";
import { useGroup, useTrackedState } from "opshot/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGraphDefinition } from "../../../hooks/useGraphDefinition";
import { useGraphState } from "../../../hooks/useGraphState";
import { ensureGraphPackagesInstalled } from "../../../hooks/packagePipeline";
import type { AppContext, GraphContext } from "../../../models/Context";
import { createHistory, graphMeta } from "../../../models/History";
import type { TabEntry } from "../../../models/State/App";
import type { GraphState, GraphViewState } from "../../../models/State/Graph";
import type { GraphDefinitionState } from "../../../models/State/GraphDefinition";
import { computeAutoLayout } from "../../../utils/autoLayout";
import { importBag } from "../../../utils/bagOperations";
import { mergeImportedBag } from "../../../utils/importBag";
import { GraphCanvas } from "./Canvas";

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

		return needsLayout ? computeAutoLayout(initialDefinition.nodes, initialDefinition.edges) : initialGraphState.positions;
	}, [initialGraphState, initialDefinition]);

	const group = useGroup(graphMeta);
	const graphDefinition = useTrackedState(initialDefinition, group);
	const positions = useTrackedState({ positions: seededPositions }, group);
	const graphView = useTrackedState<GraphViewState>({ inspectedNodeId: initialGraphState.inspectedNodeId, viewport: initialGraphState.viewport });
	const [history] = useState(() => createHistory(group));

	const { flushDefinition } = useGraphDefinition(graphDefinition, initialContent, tab.bagPath, context);

	useGraphState(positions, graphView, tab.id, context);

	useEffect(() => {
		context.tabNames.mutate((mutable) => {
			mutable.names[tab.id] = graphDefinition.name;
		});
	}, [context.tabNames.op, tab.id, graphDefinition.name]);

	const onSave = useCallback(() => {
		flushDefinition();
	}, [flushDefinition]);

	const { activeCommands } = context;

	useEffect(() => {
		const rename = (name: string) => {
			graphDefinition.mutate((mutable) => {
				mutable.name = name;
			});
		};

		const importBagCommand = async () => {
			const imported = await importBag(context.main);

			if (!imported) return;

			const currentDefinition = graphDefinition.op.unwrap();
			const previousDefinition = JSON.parse(
				JSON.stringify({
					id: currentDefinition.id,
					apiVersion: currentDefinition.apiVersion,
					name: currentDefinition.name,
					nodes: currentDefinition.nodes,
					edges: currentDefinition.edges,
				}),
			) as GraphDefinition;
			const previousPositions = JSON.parse(JSON.stringify(positions.op.unwrap().positions)) as Record<string, { x: number; y: number }>;

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

			graphDefinition.mutate(
				(mutable) => {
					mutable.nodes = merged.definition.nodes;
					mutable.edges = merged.definition.edges;
				},
				{ transactionKey },
			);

			positions.mutate(
				(mutable) => {
					mutable.positions = merged.positions;
				},
				{ transactionKey },
			);

			// Import is a definition-ingress path: satisfy the merged nodes'
			// dependency pins behind the auto-install consent gate.
			if (context.app.op.unwrap().installBagPackagesAutomatically) {
				try {
					await ensureGraphPackagesInstalled(merged.definition, context.app, context.main);
				} catch (error) {
					context.logger.error("Failed to install packages required by imported bag", error as Error, {
						namespace: "packages",
					});
				}
			}
		};

		activeCommands.mutate((mutable) => {
			mutable.undo = () => history.undo();
			mutable.redo = () => history.redo();

			const { canUndo, canRedo } = history.op.unwrap();

			mutable.canUndo = canUndo;
			mutable.canRedo = canRedo;
			mutable.rename = rename;
			mutable.importBag = importBagCommand;
			mutable.save = onSave;
		});

		const unsubscribe = history.op.subscribe(() => {
			activeCommands.mutate((mutable) => {
				const { canUndo, canRedo } = history.op.unwrap();

				mutable.canUndo = canUndo;
				mutable.canRedo = canRedo;
			});
		});

		return () => {
			unsubscribe();

			activeCommands.mutate((mutable) => {
				mutable.undo = null;
				mutable.redo = null;
				mutable.canUndo = false;
				mutable.canRedo = false;
				mutable.rename = null;
				mutable.importBag = null;
				mutable.save = null;
			});
		};
	}, [activeCommands.op, context.main, history, graphDefinition.op, positions.op, onSave]);

	const graphContext: GraphContext = useMemo(
		() => ({
			...context,
			graphDefinition,
			positions,
			graphView,
			history,
			flushDefinition,
			bagPath: tab.bagPath,
			bagId: tab.id,
			onSave,
		}),
		[context, graphDefinition, positions, graphView, history, flushDefinition, tab.bagPath, tab.id, onSave],
	);

	return (
		<ReactFlowProvider>
			<GraphCanvas context={graphContext} />
		</ReactFlowProvider>
	);
}
