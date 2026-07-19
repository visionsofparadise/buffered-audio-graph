import type { State } from "opshot";
import { useEffect } from "react";
import type { Main } from "../models/Main";
import type { AppState } from "../models/State/App";

/**
 * On mount, fetch the bundled-binary schema-key → absolute-path map via
 * IPC (sourced from `apps/desktop/binaries/manifest.json`, written by
 * the binary pipeline's install step — see
 * `projects/code/engineering/desktop/design-binary-pipeline.md`) and
 * populate `AppState.binaries` for each schema key that is currently
 * unset. Never overwrites a user-set path.
 *
 * Runs once per app boot (deps are stable for the hook's lifetime —
 * `app.op` survives the whole window).
 */
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
