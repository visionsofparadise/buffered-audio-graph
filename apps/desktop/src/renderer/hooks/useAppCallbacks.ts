import { useCallback, useRef } from "react";
import type { Snapshot } from "valtio/vanilla";
import type { Logger } from "../../shared/models/Logger";
import type { Main } from "../models/Main";
import type { ProxyStore } from "../models/ProxyStore/ProxyStore";
import type { AppState } from "../models/State/App";
import { loadBag, newBag, openBag, saveBagDefinition } from "../utils/bagOperations";
import { ensureGraphPackagesInstalled } from "./packagePipeline";

interface UseAppCallbacksReturn {
	readonly tabNames: Map<string, string>;
	readonly openBagTab: () => Promise<void>;
	readonly openBagByPath: (bagPath: string) => Promise<void>;
	readonly newBagTab: () => Promise<void>;
	readonly setHasPassedLoading: (value: boolean) => void;
}

export function useAppCallbacks(
	app: Snapshot<AppState>,
	appStore: ProxyStore,
	main: Main,
	logger: Logger,
	setHasPassedLoading: (value: boolean) => void,
): UseAppCallbacksReturn {
	const tabNamesRef = useRef(new Map<string, string>());

	const addTab = useCallback(
		(bagId: string, bagPath: string, name: string) => {
			appStore.mutate(app, (proxy) => {
				if (proxy.tabs.some((tab) => tab.id === bagId)) {
					proxy.activeTabId = bagId;

					return;
				}

				proxy.tabs.push({ id: bagId, bagPath });
				proxy.activeTabId = bagId;

				const existing = proxy.recentFiles.filter((rf) => rf.id !== bagId);

				existing.unshift({ id: bagId, bagPath, name, lastOpened: Date.now() });
				proxy.recentFiles = existing.slice(0, 20);
			});

			tabNamesRef.current.set(bagId, name);
		},
		[app, appStore],
	);

	const openBagByPath = useCallback(
		async (bagPath: string) => {
			const definition = await loadBag(main, bagPath);

			setHasPassedLoading(false);

			// Dependency satisfaction is automatic and bag-driven, gated by the
			// auto-install setting. With it off, an unsatisfiable pin lands the bag
			// in the existing degraded state (nodeLookup surfaces the missing
			// package on each node).
			if (app.installBagPackagesAutomatically) {
				try {
					await ensureGraphPackagesInstalled(definition, app, appStore, main);
				} catch (error) {
					logger.error("Failed to install exact package versions required by bag", error as Error, {
						namespace: "packages",
						bagPath,
					});
				}
			}

			setHasPassedLoading(true);

			addTab(definition.id, bagPath, definition.name);
		},
		[addTab, app, appStore, main, logger, setHasPassedLoading],
	);

	const openBagTab = useCallback(async () => {
		const bagPath = await openBag(main);

		if (!bagPath) return;

		await openBagByPath(bagPath);
	}, [main, openBagByPath]);

	const newBagTab = useCallback(async () => {
		const result = await newBag(main);

		if (!result) return;

		const readyBufferedAudioNodes = app.packages.filter((entry) => entry.name === "@buffered-audio/nodes" && entry.status === "ready" && entry.version !== null);

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
				result.definition.packages = { "@buffered-audio/nodes": latest.version ?? "" };
				result.definition.nodes.push({
					id: crypto.randomUUID(),
					packageName: "@buffered-audio/nodes",
					nodeName: "Read WAV",
				});

				await saveBagDefinition(main, result.bagPath, result.definition);
			}
		}

		addTab(result.definition.id, result.bagPath, result.definition.name);
	}, [addTab, app.packages, main, logger]);

	return {
		tabNames: tabNamesRef.current,
		openBagTab,
		openBagByPath,
		newBagTab,
		setHasPassedLoading,
	};
}
