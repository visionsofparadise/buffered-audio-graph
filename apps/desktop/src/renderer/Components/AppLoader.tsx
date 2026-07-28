import { useQuery } from "@tanstack/react-query";
import { useTrackedState } from "opshot/react";
import { useEffect, useMemo, useState } from "react";
import { useAppCallbacks } from "../hooks/useAppCallbacks";
import { useAutosave } from "../hooks/useAutosave";
import { useBinaryDefaults } from "../hooks/useBinaryDefaults";
import { usePackageLoader } from "../hooks/usePackageLoader";
import { useWindowState } from "../hooks/useWindowState";
import { main } from "../Models/Main";
import { MainEvents } from "../Models/MainEvents";
import { loadAppState, useAppState, type AppState } from "../Models/State/App";
import { Layout, type LayoutContextInput } from "./Layout";
import type { Logger } from "../../shared/Models/Logger";
import type { ActiveCommands } from "../Models/State/ActiveCommands";
import type { QueryClient } from "@tanstack/react-query";

interface Props {
	readonly queryClient: QueryClient;
	readonly logger: Logger;
}

interface RuntimeProps {
	readonly initialState: AppState;
	readonly windowId: string;
	readonly userDataPath: string;
	readonly queryClient: QueryClient;
	readonly logger: Logger;
}

function AppRuntime({ initialState, windowId, userDataPath, queryClient, logger }: RuntimeProps) {
	const app = useAppState(initialState);
	const mainEvents = useMemo(() => new MainEvents(main), []);

	useWindowState(app, main, mainEvents);
	useBinaryDefaults(app, main);
	useAutosave(app, main, userDataPath);

	const catalogPackages = app.packages.filter((entry) => entry.origin === "catalog");
	const { isLoading } = usePackageLoader(app, main);
	const hasUnresolvedPackages = catalogPackages.some((entry) => entry.status !== "ready" && entry.status !== "error");
	const hasError = catalogPackages.some((entry) => entry.status === "error");
	const isLoadingPackages = isLoading || hasUnresolvedPackages;

	const [hasPassedLoading, setHasPassedLoading] = useState(false);

	useEffect(() => {
		if (!hasPassedLoading && !isLoadingPackages && !hasError) {
			setHasPassedLoading(true);
		}
	}, [hasPassedLoading, isLoadingPackages, hasError]);

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

	const context = useMemo(
		(): LayoutContextInput => ({
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
		}),
		[app, logger, mainEvents, queryClient, userDataPath, windowId, activeCommands, callbacks],
	);

	return (
		<Layout
			context={context}
			packages={catalogPackages}
			isLoadingPackages={isLoadingPackages}
			hasPassedLoading={hasPassedLoading}
			onContinueLoading={() => setHasPassedLoading(true)}
		/>
	);
}

export function AppLoader({ queryClient, logger }: Props) {
	const { data: initialState } = useQuery({
		queryKey: ["initialState"],
		queryFn: () => loadAppState(main),
	});

	const { data: windowId } = useQuery({
		queryKey: ["windowId"],
		queryFn: () => main.getWindowId(),
	});

	const { data: userDataPath } = useQuery({
		queryKey: ["userDataPath"],
		queryFn: () => main.getUserDataPath(),
	});

	if (!initialState || !windowId || !userDataPath) {
		return (
			<div className="flex h-screen items-center justify-center bg-surface">
				<div className="type-label text-text-secondary">Loading...</div>
			</div>
		);
	}

	return (
		<AppRuntime
			initialState={initialState}
			windowId={windowId}
			userDataPath={userDataPath}
			queryClient={queryClient}
			logger={logger}
		/>
	);
}
