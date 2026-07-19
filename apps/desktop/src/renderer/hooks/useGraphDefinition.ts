import type { State } from "opshot";
import { useCallback, useEffect, useRef } from "react";
import { SUPPORTED_API_VERSIONS } from "../../shared/models/ApiVersion";
import type { FileChangedPayload } from "../../shared/utilities/emitToRenderer";
import type { AppContext } from "../models/Context";
import type { GraphMeta } from "../models/History";
import {
	loadGraphDefinition,
	serializeGraphDefinition,
	type GraphDefinitionState,
} from "../models/State/GraphDefinition";
import { ensureGraphPackagesInstalled } from "./packagePipeline";

/** Disk-write debounce window for autosave (ms). */
const SAVE_DEBOUNCE_MS = 800;

interface UseGraphDefinitionResult {
	/** Force an immediate save of the pending debounced edit to disk. */
	readonly flushDefinition: () => void;
}

async function sha256Hex(content: string): Promise<string> {
	const encoded = new TextEncoder().encode(content);
	const buffer = await crypto.subtle.digest("SHA-256", encoded);
	const bytes = new Uint8Array(buffer);

	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { loadGraphDefinition };

export function useGraphDefinition(
	graphDefinition: State<GraphDefinitionState, GraphMeta, GraphMeta>,
	initialContent: string,
	bagPath: string,
	context: AppContext,
): UseGraphDefinitionResult {
	const { main, mainEvents } = context;

	const contextRef = useRef(context);

	contextRef.current = context;

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

	const flushDefinition = useCallback((): void => {
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
		const unsubscribe = graphDefinition.op.subscribe(() => {
			const json = serializeGraphDefinition(graphDefinition.op.unwrap());

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
			flushDefinition();
		};

		window.addEventListener("beforeunload", handleBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
			unsubscribe();
			flushDefinition();
		};
	}, [graphDefinition.op, main, flushDefinition]);

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
					const validated = await main.validateGraphDefinition(parsed);

					if (!SUPPORTED_API_VERSIONS.has(validated.apiVersion)) {
						throw new Error(`Bag API version ${String(validated.apiVersion)} is not supported`);
					}

					const newHash = await sha256Hex(content);

					hashRef.current = newHash;

					graphDefinition.mutate(
						(mutable) => {
							mutable.id = validated.id;
							mutable.apiVersion = validated.apiVersion;
							mutable.name = validated.name;
							mutable.nodes = validated.nodes;
							mutable.edges = validated.edges;
						},
						{ external: true },
					);

					// External-reconcile is a definition-ingress path: satisfy the
					// reconciled nodes' dependency pins, gated by the auto-install
					// toggle. Non-blocking (the render gate covers the interim);
					// errors are logged.
					const { app, logger } = contextRef.current;

					if (app.installBagPackagesAutomatically) {
						void ensureGraphPackagesInstalled(validated, app, main).catch((error: unknown) => {
							logger.error("Failed to install packages for externally-edited bag", error as Error, {
								namespace: "packages",
							});
						});
					}
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
	}, [bagPath, mainEvents, main, graphDefinition.op]);

	return { flushDefinition };
}
