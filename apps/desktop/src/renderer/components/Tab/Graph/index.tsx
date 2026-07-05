import { useEffect, useMemo, useState } from "react";
import { loadGraphDefinition } from "../../../hooks/useGraphDefinition";
import type { AppContext } from "../../../models/Context";
import { ProxyStore } from "../../../models/ProxyStore/ProxyStore";
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
	readonly initialGraphState: Omit<GraphState, "_key">;
	readonly initialDefinition: Omit<GraphDefinitionState, "_key">;
	readonly initialContent: string;
}

export function GraphView({ tab, context }: Props) {
	const graphStore = useMemo(() => new ProxyStore(), []);
	const [initial, setInitial] = useState<InitialLoad | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		const state = { cancelled: false };

		void (async () => {
			try {
				const [graphState, { definition, content }] = await Promise.all([
					loadGraphState(context.main, context.userDataPath, tab.id),
					loadGraphDefinition(tab.bagPath, context.main),
				]);

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
			graphStore={graphStore}
			context={context}
		/>
	);
}
