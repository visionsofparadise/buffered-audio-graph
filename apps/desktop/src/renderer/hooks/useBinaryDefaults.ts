import { useEffect } from "react";
import type { Main } from "../Models/Main";
import type { AppState } from "../Models/State/App";
import type { State } from "opshot";

export function useBinaryDefaults(app: State<AppState>, main: Main): void {
	useEffect(() => {
		let cancelled = false;

		void main.getBundledBinaryDefaults().then((bundled) => {
			if (cancelled) return;

			const updates: Array<[string, string]> = [];
			const { binaries } = app.op.unwrap();

			for (const [key, bundledPath] of Object.entries(bundled)) {
				const existing = (binaries as Readonly<Record<string, string>>)[key];

				if (existing !== undefined && existing !== "") continue;

				updates.push([key, bundledPath]);
			}

			if (updates.length === 0) return;

			app.mutate((mutable) => {
				for (const [key, bundledPath] of updates) {
					if (mutable.binaries[key] !== undefined && mutable.binaries[key] !== "") continue;

					mutable.binaries[key] = bundledPath;
				}
			});
		});

		return () => {
			cancelled = true;
		};
	}, [app.op, main]);
}
