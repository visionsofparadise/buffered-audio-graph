import { validateGraphDefinition, type GraphDefinition } from "@buffered-audio/core";
import { useCallback, useEffect, useRef } from "react";
import { snapshot, subscribe, type Snapshot } from "valtio/vanilla";
import type { FileChangedPayload } from "../../shared/utilities/emitToRenderer";
import type { AppContext } from "../models/Context";
import type { ProxyStore } from "../models/ProxyStore/ProxyStore";
import { useCreateState } from "../models/ProxyStore/hooks/useCreateState";
import {
	loadGraphDefinition,
	serializeGraphDefinition,
	type GraphDefinitionState,
} from "../models/State/GraphDefinition";

/** Disk-write debounce window for autosave (ms). */
const SAVE_DEBOUNCE_MS = 800;

/**
 * `mutateDefinition` with a `flush` method attached. `flush` writes any
 * pending debounced edit to disk immediately.
 */
export type MutateDefinition = ((updater: (definition: GraphDefinition) => GraphDefinition) => void) & {
	flush: () => void;
};

interface UseGraphDefinitionResult {
	readonly graphDefinition: Snapshot<GraphDefinitionState>;
	readonly mutateDefinition: MutateDefinition;
}

async function sha256Hex(content: string): Promise<string> {
	const encoded = new TextEncoder().encode(content);
	const buffer = await crypto.subtle.digest("SHA-256", encoded);
	const bytes = new Uint8Array(buffer);

	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { loadGraphDefinition };

export function useGraphDefinition(
	initialDefinition: Omit<GraphDefinitionState, "_key">,
	initialContent: string,
	store: ProxyStore,
	bagPath: string,
	context: AppContext,
): UseGraphDefinitionResult {
	const { main, mainEvents } = context;
	const graphDefinition = useCreateState<GraphDefinitionState>(initialDefinition, store);

	const hashRef = useRef<string | null>(null);
	const pendingJsonRef = useRef<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const bagPathRef = useRef(bagPath);

	bagPathRef.current = bagPath;

	useEffect(() => {
		void sha256Hex(initialContent).then((hash) => {
			hashRef.current = hash;
		});
	}, [initialContent]);

	const flush = useCallback((): void => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}

		const json = pendingJsonRef.current;

		if (json === null) return;

		pendingJsonRef.current = null;

		void sha256Hex(json).then((hash) => {
			hashRef.current = hash;
		});

		void main.writeFile(bagPathRef.current, json);
	}, [main]);

	useEffect(() => {
		const proxy = store.dangerouslyGetProxy<GraphDefinitionState>(graphDefinition._key);

		if (!proxy) return;

		const unsubscribe = subscribe(proxy, () => {
			const json = serializeGraphDefinition(snapshot(proxy));

			pendingJsonRef.current = json;

			void sha256Hex(json).then((hash) => {
				hashRef.current = hash;
			});

			if (timerRef.current !== null) {
				clearTimeout(timerRef.current);
			}

			timerRef.current = setTimeout(() => {
				timerRef.current = null;

				const pending = pendingJsonRef.current;

				if (pending === null) return;

				pendingJsonRef.current = null;
				void main.writeFile(bagPathRef.current, pending);
			}, SAVE_DEBOUNCE_MS);
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
	}, [graphDefinition._key, store, main, flush]);

	useEffect(() => {
		void main.watchFile(bagPath);

		return () => {
			void main.unwatchFile(bagPath);
		};
	}, [bagPath, main]);

	useEffect(() => {
		const handler = (payload: FileChangedPayload): void => {
			if (payload.path !== bagPath) return;
			if (hashRef.current === null) return;
			if (payload.contentHash === hashRef.current) return;

			void (async () => {
				try {
					const content = await main.readFile(bagPath);
					const parsed: unknown = JSON.parse(content);
					const validated = validateGraphDefinition(parsed);
					const newHash = await sha256Hex(content);

					hashRef.current = newHash;

					store.mutate(graphDefinition, (proxy) => {
						proxy.id = validated.id;
						proxy.name = validated.name;
						proxy.nodes = validated.nodes;
						proxy.edges = validated.edges;
					});
				} catch {
					// External edit produced invalid JSON or schema; let the
					// next valid write reconcile.
				}
			})();
		};

		mainEvents.on("file:changed", handler);

		return () => {
			mainEvents.off("file:changed", handler);
		};
	}, [bagPath, mainEvents, main, store, graphDefinition]);

	const mutateDefinition = useCallback(
		((updater: (definition: GraphDefinition) => GraphDefinition) => {
			store.mutate(graphDefinition, (proxy) => {
				const current: GraphDefinition = {
					id: proxy.id,
					name: proxy.name,
					nodes: structuredClone(proxy.nodes as Array<GraphDefinition["nodes"][number]>),
					edges: structuredClone(proxy.edges as Array<GraphDefinition["edges"][number]>),
				};
				const next = updater(current);

				proxy.id = next.id;
				proxy.name = next.name;
				proxy.nodes = next.nodes;
				proxy.edges = next.edges;
			});
		}) as MutateDefinition,
		[store, graphDefinition],
	);

	mutateDefinition.flush = flush;

	return { graphDefinition, mutateDefinition };
}
