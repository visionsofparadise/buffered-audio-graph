import { identify, useMutableState } from "opshot";
import { useCallback } from "react";
import { loadBag, newBag, openBag, saveBagDefinition } from "../utils/bagOperations";
import { comparePackageVersions } from "./packagePipeline";
import type { Logger } from "../../shared/Models/Logger";
import type { TabNamesState } from "../Models/Context";
import type { Main } from "../Models/Main";
import type { AppState } from "../Models/State/App";

interface UseAppCallbacksReturn {
	readonly tabNames: TabNamesState;
	readonly openBagTab: () => Promise<void>;
	readonly openBagByPath: (bagPath: string) => Promise<void>;
	readonly newBagTab: () => Promise<void>;
}

export function useAppCallbacks(app: AppState, main: Main, logger: Logger): UseAppCallbacksReturn {
	const tabNames = useMutableState<TabNamesState>({ names: {} });

	const addTab = useCallback(
		(bagId: string, bagPath: string, name: string) => {
			if (app.tabs.some((tab) => tab.id === bagId)) {
				app.activeTabId = bagId;
			} else {
				app.tabs.push({ id: bagId, bagPath });
				app.activeTabId = bagId;

				const existing = app.recentFiles.filter((rf) => rf.id !== bagId);

				existing.unshift({ id: bagId, bagPath, name, lastOpened: Date.now() });
				app.recentFiles = existing.slice(0, 20);
			}

			tabNames.names[bagId] = name;
		},
		[identify(app), identify(tabNames)],
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
			(entry) =>
				entry.name === "@buffered-audio/nodes" &&
				entry.origin === "catalog" &&
				entry.status === "ready" &&
				entry.version !== null,
		);

		if (readyBufferedAudioNodes.length > 0) {
			const latest = readyBufferedAudioNodes.reduce((winner, candidate) =>
				comparePackageVersions(candidate.version ?? "", winner.version ?? "") > 0 ? candidate : winner,
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
	}, [addTab, identify(app), main, logger]);

	return {
		tabNames,
		openBagTab,
		openBagByPath,
		newBagTab,
	};
}
