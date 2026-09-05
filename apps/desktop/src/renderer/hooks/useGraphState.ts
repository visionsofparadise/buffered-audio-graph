import { identify, subscribe } from "opshot";
import { useEffect, useRef } from "react";
import { serializeGraphState, type GraphViewState, type PositionsState } from "../Models/State/Graph";
import type { AppContext } from "../Models/Context";

const STATE_DEBOUNCE_MS = 800;

export function useGraphState(
	positions: PositionsState,
	graphView: GraphViewState,
	bagId: string,
	context: AppContext,
): void {
	const { main, userDataPath } = context;

	const pendingDataRef = useRef<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const filePath = `${userDataPath}/graphs/${bagId}.json`;
	const filePathRef = useRef(filePath);

	filePathRef.current = filePath;

	useEffect(() => {
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

		const schedule = (): void => {
			pendingDataRef.current = serializeGraphState(positions, graphView);

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
		};

		const unsubscribePositions = subscribe(positions, schedule);
		const unsubscribeGraphView = subscribe(graphView, schedule);

		const handleBeforeUnload = (): void => {
			flush();
		};

		window.addEventListener("beforeunload", handleBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
			unsubscribePositions();
			unsubscribeGraphView();
			flush();
		};
	}, [identify(positions), identify(graphView), main]);
}
