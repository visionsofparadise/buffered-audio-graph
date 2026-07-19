import type { QueryClient } from "@tanstack/react-query";
import { useTrackedState } from "opshot/react";
import { useEffect, useMemo, useState } from "react";
import type { Logger } from "../../shared/models/Logger";
import { useAppCallbacks } from "../hooks/useAppCallbacks";
import { useAutosave } from "../hooks/useAutosave";
import { useBinaryDefaults } from "../hooks/useBinaryDefaults";
import { usePackageLoader } from "../hooks/usePackageLoader";
import { useWindowState } from "../hooks/useWindowState";
import type { AppContext } from "../models/Context";
import { main } from "../models/Main";
import { MainEvents } from "../models/MainEvents";
import type { ActiveCommands } from "../models/State/ActiveCommands";
import { useAppState, type AppState } from "../models/State/App";
import { LoadingScreen } from "./LoadingScreen";
import { Settings } from "./Settings";
import { AppBar } from "./AppBar";
import { TabContent } from "./Tab";

interface Props {
	readonly initialState: AppState;
	readonly windowId: string;
	readonly userDataPath: string;
	readonly queryClient: QueryClient;
	readonly logger: Logger;
}

export function AppLayout({ initialState, windowId, userDataPath, queryClient, logger }: Props) {
	const app = useAppState(initialState);

	const mainEvents = useMemo(() => new MainEvents(main), []);

	useWindowState(app, main, mainEvents);
	useBinaryDefaults(app, main);
	useAutosave(app, main, userDataPath);

	const catalogPackages = app.packages.filter((entry) => entry.origin === "catalog");
	const { isLoading } = usePackageLoader(app, main);
	const hasUnresolvedPackages = catalogPackages.some((entry) => entry.status !== "ready" && entry.status !== "error");
	const hasError = catalogPackages.some((entry) => entry.status === "error");

	const [hasPassedLoading, setHasPassedLoading] = useState(false);

	useEffect(() => {
		if (!hasPassedLoading && !isLoading && !hasUnresolvedPackages && !hasError) {
			setHasPassedLoading(true);
		}
	}, [hasPassedLoading, isLoading, hasUnresolvedPackages, hasError]);

	const [settingsOpen, setSettingsOpen] = useState(false);

	const callbacks = useAppCallbacks(app, main, logger);

	const activeCommands = useTrackedState<ActiveCommands>({
		undo: null,
		redo: null,
		canUndo: false,
		canRedo: false,
		rename: null,
		importBag: null,
		save: null,
	});

	const context: AppContext = useMemo(
		() => ({
			app,
			activeCommands,
			logger,
			main,
			mainEvents,
			queryClient,
			userDataPath,
			windowId,
			tabNames: callbacks.tabNames,
			openBagTab: callbacks.openBagTab,
			openBagByPath: callbacks.openBagByPath,
			newBagTab: callbacks.newBagTab,
			renameTab: (_tabId, newName) => {
				activeCommands.op.unwrap().rename?.(newName);
			},
			importBagIntoActiveTab: async () => {
				await activeCommands.op.unwrap().importBag?.();
			},
			setSettingsOpen,
		}),
		[app, logger, mainEvents, queryClient, userDataPath, windowId, activeCommands, callbacks],
	);

	if (!hasPassedLoading) {
		return (
			<div className="flex flex-col h-screen">
				<AppBar context={context} chromeOnly />
				<LoadingScreen
					packages={catalogPackages}
					isLoading={isLoading || hasUnresolvedPackages}
					onContinue={() => setHasPassedLoading(true)}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-screen">
			<AppBar context={context} />
			<TabContent context={context} />
			<Settings
				isOpen={settingsOpen}
				onClose={() => setSettingsOpen(false)}
				context={context}
			/>
		</div>
	);
}
