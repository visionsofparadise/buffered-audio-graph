import type { State } from "opshot";
import { useEffect, useState } from "react";
import type { Main } from "../models/Main";
import type { AppState } from "../models/State/App";
import { mutatePackageAt, runPackagePipeline } from "./packagePipeline";

export function usePackageLoader(
	app: State<AppState>,
	main: Main,
): { isLoading: boolean } {
	const [isLoading, setIsLoading] = useState(() =>
		app.packages.some(
			(entry) => entry.origin === "catalog" && entry.status !== "ready" && entry.status !== "error",
		),
	);

	useEffect(() => {
		let cancelled = false;

		async function loadAll(): Promise<void> {
			const indices = app.op
				.unwrap()
				.packages.map((entry, index) => ({ entry, index }))
				.filter(({ entry }) => entry.origin === "catalog" && entry.status === "pending")
				.sort((left, right) => (left.entry.isBuiltIn === right.entry.isBuiltIn ? 0 : left.entry.isBuiltIn ? -1 : 1));

			if (indices.length > 0) {
				setIsLoading(true);
			}

			for (const { entry, index } of indices) {
				if (cancelled) return;

				try {
					await runPackagePipeline(entry, index, app, main);
				} catch (error) {
					mutatePackageAt(app, index, (target) => {
						target.status = "error";
						target.error = error instanceof Error ? error.message : String(error);
					});
				}
			}

			if (!cancelled) {
				setIsLoading(false);
			}
		}

		void loadAll();

		return () => {
			cancelled = true;
		};
	}, [app.op, main]);

	return { isLoading };
}
