import type { State } from "opshot";
import { useEffect } from "react";
import type { Main } from "../models/Main";
import type { AppState } from "../models/State/App";

const DEBOUNCE_MS = 500;

export function useAutosave(app: State<AppState>, main: Main, userDataPath: string): void {
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let pendingData: string | null = null;

		function flush(): void {
			if (pendingData !== null) {
				const data = pendingData;

				pendingData = null;
				void main.writeFile(`${userDataPath}/state.json`, data);
			}
		}

		const unsubscribe = app.op.subscribe(() => {
			pendingData = JSON.stringify(app.op.unwrap(), null, 2);

			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				flush();
			}, DEBOUNCE_MS);
		});

		const onBeforeUnload = (): void => {
			flush();
		};

		window.addEventListener("beforeunload", onBeforeUnload);

		return () => {
			unsubscribe();
			window.removeEventListener("beforeunload", onBeforeUnload);

			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}

			flush();
		};
	}, [app.op, main, userDataPath]);
}
