import { identify } from "opshot";
import { useEffect } from "react";
import type { Main } from "../Models/Main";
import type { AppState } from "../Models/State/App";

export function useBinaryDefaults(app: AppState, main: Main): void {
	useEffect(() => {
		let cancelled = false;

		void main.getBundledBinaryDefaults().then((bundled) => {
			if (cancelled) return;

			const updates: Array<[string, string]> = [];
			const { binaries } = app;

			for (const [key, bundledPath] of Object.entries(bundled)) {
				const existing = (binaries as Readonly<Record<string, string>>)[key];

				if (existing !== undefined && existing !== "") continue;

				updates.push([key, bundledPath]);
			}

			if (updates.length === 0) return;

			for (const [key, bundledPath] of updates) {
				if (app.binaries[key] !== undefined && app.binaries[key] !== "") continue;

				app.binaries[key] = bundledPath;
			}
		});

		return () => {
			cancelled = true;
		};
	}, [identify(app), main]);
}
