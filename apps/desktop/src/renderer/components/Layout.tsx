import type { QueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Logger } from "../../shared/models/Logger";
import { useAppCallbacks } from "../hooks/useAppCallbacks";
import { useAutosave } from "../hooks/useAutosave";
import { useBinaryDefaults } from "../hooks/useBinaryDefaults";
import { usePackageLoader } from "../hooks/usePackageLoader";
import { useWindowState } from "../hooks/useWindowState";
import type { AppContext } from "../models/Context";
import { main } from "../models/Main";
import { MainEvents } from "../models/MainEvents";
import type { ProxyStore } from "../models/ProxyStore/ProxyStore";
import { useCreateState } from "../models/ProxyStore/hooks/useCreateState";
import type { ActiveCommands } from "../models/State/ActiveCommands";
import { useAppState, type AppState } from "../models/State/App";
import { BinaryManager } from "./BinaryManager";
import { LoadingScreen } from "./LoadingScreen";
import { ModuleManager } from "./ModuleManager";
import { TabContent } from "./Tab";
import { AppTabBar } from "./TabBar";
import { TitleBar } from "./TitleBar";

interface Props {
	readonly initialState: Omit<AppState, "_key">;
	readonly windowId: string;
	readonly userDataPath: string;
	readonly appStore: ProxyStore;
	readonly queryClient: QueryClient;
	readonly logger: Logger;
}

export function AppLayout({ initialState, windowId, userDataPath, appStore, queryClient, logger }: Props) {
	const app = useAppState(initialState, appStore);

	const mainEvents = useMemo(() => new MainEvents(main), []);

	useWindowState(app, appStore, main, mainEvents);
	useBinaryDefaults(app, appStore, main);
	useAutosave(app, appStore, main, userDataPath);

	const { isLoading } = usePackageLoader(app, appStore, main);
	const hasUnresolvedPackages = app.packages.some((entry) => entry.status !== "ready" && entry.status !== "error");

	const [hasPassedLoading, setHasPassedLoading] = useState(false);
	const [moduleManagerOpen, setModuleManagerOpen] = useState(false);
	const [binaryManagerOpen, setBinaryManagerOpen] = useState(false);

	const callbacks = useAppCallbacks(app, appStore, main, logger, setHasPassedLoading);

	const activeCommands = useCreateState<ActiveCommands>(
		{ undo: null, redo: null, canUndo: false, canRedo: false, rename: null, importBag: null, save: null },
		appStore,
	);

	const context: AppContext = useMemo(
		() => ({
			app,
			appStore,
			logger,
			main,
			mainEvents,
			queryClient,
			userDataPath,
			windowId,
			activeCommands,
			tabNames: callbacks.tabNames,
			openBagTab: callbacks.openBagTab,
			openBagByPath: callbacks.openBagByPath,
			newBagTab: callbacks.newBagTab,
			renameTab: (_tabId, newName) => {
				activeCommands.rename?.(newName);
			},
			importBagIntoActiveTab: async () => {
				await activeCommands.importBag?.();
			},
			setModuleManagerOpen,
			setBinaryManagerOpen,
		}),
		[app, appStore, logger, mainEvents, queryClient, userDataPath, windowId, activeCommands, callbacks],
	);

	if (!hasPassedLoading) {
		return (
			<div className="flex flex-col h-screen">
				<TitleBar context={context} />
				<LoadingScreen
					packages={app.packages}
					isLoading={isLoading || hasUnresolvedPackages}
					onContinue={() => setHasPassedLoading(true)}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen">
			<TitleBar context={context} />
			<AppTabBar context={context} />
			<TabContent context={context} />
			<ModuleManager
				isOpen={moduleManagerOpen}
				onClose={() => setModuleManagerOpen(false)}
				context={context}
			/>
			<BinaryManager
				isOpen={binaryManagerOpen}
				onClose={() => setBinaryManagerOpen(false)}
				context={context}
			/>
		</div>
	);
}
