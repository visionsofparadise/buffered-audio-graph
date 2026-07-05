import { useEffect, useRef } from "react";
import { snapshot, subscribe, type Snapshot } from "valtio/vanilla";
import type { AppContext } from "../models/Context";
import type { ProxyStore } from "../models/ProxyStore/ProxyStore";
import { useCreateState } from "../models/ProxyStore/hooks/useCreateState";
import { serializeGraphState, type GraphState } from "../models/State/Graph";

/** Disk-write debounce window for graph-state autosave (ms). */
const STATE_DEBOUNCE_MS = 800;

interface UseGraphStateResult {
	readonly graph: Snapshot<GraphState>;
}

export function useGraphState(
	initialState: Omit<GraphState, "_key">,
	store: ProxyStore,
	bagId: string,
	context: AppContext,
): UseGraphStateResult {
	const { main, userDataPath } = context;
	const graph = useCreateState<GraphState>(initialState, store);

	const pendingDataRef = useRef<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const filePath = `${userDataPath}/graphs/${bagId}.json`;
	const filePathRef = useRef(filePath);

	filePathRef.current = filePath;

	useEffect(() => {
		const proxy = store.dangerouslyGetProxy<GraphState>(graph._key);

		if (!proxy) return;

		const flush = (): void => {
			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}

			const data = pendingDataRef.current;

			if (data === null) return;

			pendingDataRef.current = null;
			void main.writeFile(filePathRef.current, data);
		};

		const unsubscribe = subscribe(proxy, () => {
			pendingDataRef.current = serializeGraphState(snapshot(proxy));

			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}

			timerRef.current = setTimeout(() => {
				timerRef.current = null;

				const data = pendingDataRef.current;

				if (data === null) return;

				pendingDataRef.current = null;
				void main.writeFile(filePathRef.current, data);
			}, STATE_DEBOUNCE_MS);
		});

		const handleBeforeUnload = (): void => {
			flush();
		};

		window.addEventListener("beforeunload", handleBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
			unsubscribe();
			flush();
		};
	}, [graph._key, store, main]);

	return { graph };
}
