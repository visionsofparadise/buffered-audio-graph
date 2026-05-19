import { validateGraphDefinition, type GraphDefinition } from "@buffered-audio/core";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import type { FileChangedPayload } from "../../shared/utilities/emitToRenderer";
import type { AppContext } from "../models/Context";



async function sha256Hex(content: string): Promise<string> {
	const encoded = new TextEncoder().encode(content);
	const buffer = await crypto.subtle.digest("SHA-256", encoded);
	const bytes = new Uint8Array(buffer);

	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function queryKey(bagPath: string): readonly [string, string] {
	return ["graphDefinition", bagPath] as const;
}

export function useGraphDefinition(
	bagPath: string,
	context: AppContext,
): {
	graphDefinition: GraphDefinition | undefined;
	mutateDefinition: (updater: (definition: GraphDefinition) => GraphDefinition) => void;
	isLoading: boolean;
	error: Error | null;
} {
	const { main, mainEvents, queryClient } = context;
	const hashRef = useRef<string | null>(null);
	const key = queryKey(bagPath);

	const { data: graphDefinition, isLoading, error } = useQuery<GraphDefinition>({
		queryKey: key,
		queryFn: async () => {
			const content = await main.readFile(bagPath);
			const parsed: unknown = JSON.parse(content);
			const validated = validateGraphDefinition(parsed);
			const hash = await sha256Hex(content);

			hashRef.current = hash;

			return validated;
		},
	});

	const mutateDefinition = useCallback(
		(updater: (definition: GraphDefinition) => GraphDefinition) => {
			const current = queryClient.getQueryData<GraphDefinition>(key);

			if (!current) return;

			const next = updater(current);
			const json = JSON.stringify(next, null, 2);

			queryClient.setQueryData<GraphDefinition>(key, next);

			void sha256Hex(json).then((hash) => {
				hashRef.current = hash;
			});

			void main.writeFile(bagPath, json);
		},
		[bagPath, main, queryClient, key],
	);

	// File watching
	useEffect(() => {
		void main.watchFile(bagPath);

		return () => {
			void main.unwatchFile(bagPath);
		};
	}, [bagPath, main]);

	// Reconcile external edits
	useEffect(() => {
		const handler = (payload: FileChangedPayload): void => {
			if (payload.path !== bagPath) return;
			if (hashRef.current === null) return;
			if (payload.contentHash === hashRef.current) return;

			void queryClient.invalidateQueries({ queryKey: key });
		};

		mainEvents.on("file:changed", handler);

		return () => {
			mainEvents.off("file:changed", handler);
		};
	}, [bagPath, mainEvents, queryClient, key]);

	return { graphDefinition, mutateDefinition, isLoading, error };
}
