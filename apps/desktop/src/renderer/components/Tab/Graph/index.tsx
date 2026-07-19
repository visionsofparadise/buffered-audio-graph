import { useEffect, useRef, useState } from "react";
import { ensureGraphPackagesInstalled } from "../../../hooks/packagePipeline";
import { loadGraphDefinition } from "../../../hooks/useGraphDefinition";
import type { AppContext } from "../../../models/Context";
import type { TabEntry } from "../../../models/State/App";
import type { GraphState } from "../../../models/State/Graph";
import { loadGraphState } from "../../../models/State/Graph";
import type { GraphDefinitionState } from "../../../models/State/GraphDefinition";
import { GraphSession } from "./Session";

interface Props {
	readonly tab: TabEntry;
	readonly context: AppContext;
}

interface InitialLoad {
	readonly initialGraphState: GraphState;
	readonly initialDefinition: GraphDefinitionState;
	readonly initialContent: string;
}

export function GraphView({ tab, context }: Props) {
	const [initial, setInitial] = useState<InitialLoad | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const contextRef = useRef(context);

	contextRef.current = context;

	useEffect(() => {
		const state = { cancelled: false };

		void (async () => {
			try {
				const [graphState, { definition, content }] = await Promise.all([
					loadGraphState(context.main, context.userDataPath, tab.id),
					loadGraphDefinition(tab.bagPath, context.main),
				]);
				const currentContext = contextRef.current;

				if (currentContext.app.installBagPackagesAutomatically) {
					try {
						await ensureGraphPackagesInstalled(
							definition,
							currentContext.app,
							currentContext.main,
						);
					} catch (error) {
						currentContext.logger.error("Failed to install exact package versions required by bag", error as Error, {
							namespace: "packages",
							bagPath: tab.bagPath,
						});
					}
				}

				if (!state.cancelled) {
					setInitial({ initialGraphState: graphState, initialDefinition: definition, initialContent: content });
				}
			} catch (error: unknown) {
				if (!state.cancelled) {
					setLoadError(error instanceof Error ? error.message : String(error));
				}
			}
		})();

		return () => {
			state.cancelled = true;
		};
	}, [context.main, context.userDataPath, tab.bagPath, tab.id]);

	if (loadError) {
		return <div className="flex flex-1 items-center justify-center bg-surface text-accent-primary type-label">Failed to load graph: {loadError}</div>;
	}

	if (!initial) {
		return <div className="flex flex-1 items-center justify-center bg-surface text-text-secondary type-label">Loading graph...</div>;
	}

	return (
		<GraphSession
			initialGraphState={initial.initialGraphState}
			initialDefinition={initial.initialDefinition}
			initialContent={initial.initialContent}
			tab={tab}
			context={context}
		/>
	);
}
