import type { State } from "opshot";
import { useTrackedState } from "opshot/react";
import { useCallback } from "react";
import type { Logger } from "../../shared/models/Logger";
import type { TabNamesState } from "../models/Context";
import type { Main } from "../models/Main";
import type { AppState } from "../models/State/App";
import { loadBag, newBag, openBag, saveBagDefinition } from "../utils/bagOperations";

interface UseAppCallbacksReturn {
	readonly tabNames: State<TabNamesState>;
	readonly openBagTab: () => Promise<void>;
	readonly openBagByPath: (bagPath: string) => Promise<void>;
	readonly newBagTab: () => Promise<void>;
}

export function useAppCallbacks(
	app: State<AppState>,
	main: Main,
	logger: Logger,
): UseAppCallbacksReturn {
	const tabNames = useTrackedState<TabNamesState>({ names: {} });

	const addTab = useCallback(
		(bagId: string, bagPath: string, name: string) => {
			app.mutate((mutable) => {
				if (mutable.tabs.some((tab) => tab.id === bagId)) {
					mutable.activeTabId = bagId;

					return;
				}

				mutable.tabs.push({ id: bagId, bagPath });
				mutable.activeTabId = bagId;

				const existing = mutable.recentFiles.filter((rf) => rf.id !== bagId);

				existing.unshift({ id: bagId, bagPath, name, lastOpened: Date.now() });
				mutable.recentFiles = existing.slice(0, 20);
			});

			tabNames.mutate((mutable) => {
				mutable.names[bagId] = name;
			});
		},
		[app, tabNames],
	);

	const openBagByPath = useCallback(
		async (bagPath: string) => {
			const definition = await loadBag(main, bagPath);

			addTab(definition.id, bagPath, definition.name);
		},
		[addTab, main],
	);

	const openBagTab = useCallback(async () => {
		const bagPath = await openBag(main);

		if (!bagPath) return;

		await openBagByPath(bagPath);
	}, [main, openBagByPath]);

	const newBagTab = useCallback(async () => {
		const result = await newBag(main);

		if (!result) return;

		const readyBufferedAudioNodes = app.packages.filter(
			(entry) => entry.name === "@buffered-audio/nodes" && entry.origin === "catalog" && entry.status === "ready" && entry.version !== null,
		);

		if (readyBufferedAudioNodes.length > 0) {
			const latest = readyBufferedAudioNodes.reduce((winner, candidate) =>
				(candidate.version ?? "").localeCompare(winner.version ?? "", undefined, { numeric: true, sensitivity: "base" }) > 0 ? candidate : winner,
			);

			if (latest.apiVersion !== null && latest.apiVersion !== result.definition.apiVersion) {
				logger.error(
					`Cannot seed new bag: package @buffered-audio/nodes is on API version ${String(latest.apiVersion)} but the bag is on API version ${String(result.definition.apiVersion)}`,
					undefined,
					{ namespace: "graph" },
				);
			} else {
				result.definition.nodes.push({
					id: crypto.randomUUID(),
					packageName: "@buffered-audio/nodes",
					packageVersion: latest.version ?? "",
					nodeName: "Read WAV",
				});

				await saveBagDefinition(main, result.bagPath, result.definition);
			}
		}

		addTab(result.definition.id, result.bagPath, result.definition.name);
	}, [addTab, app.packages, main, logger]);

	return {
		tabNames,
		openBagTab,
		openBagByPath,
		newBagTab,
	};
}
