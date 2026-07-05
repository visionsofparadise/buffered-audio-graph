import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import type { Logger } from "../../shared/models/Logger";
import { main } from "../models/Main";
import { ProxyStore } from "../models/ProxyStore/ProxyStore";
import { loadAppState } from "../models/State/App";
import { AppLayout } from "./Layout";

const appStore = new ProxyStore();

interface Props {
	readonly queryClient: QueryClient;
	readonly logger: Logger;
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
		<AppLayout
			initialState={initialState}
			windowId={windowId}
			userDataPath={userDataPath}
			appStore={appStore}
			queryClient={queryClient}
			logger={logger}
		/>
	);
}
