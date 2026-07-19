import type { State } from "opshot";
import { useEffect, useRef } from "react";
import type { AppContext } from "../models/Context";
import type { GraphMeta } from "../models/History";
import { serializeGraphState, type GraphViewState, type PositionsState } from "../models/State/Graph";

/** Disk-write debounce window for graph-state autosave (ms). */
const STATE_DEBOUNCE_MS = 800;

export function useGraphState(
	positions: State<PositionsState, GraphMeta, GraphMeta>,
	graphView: State<GraphViewState>,
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
			pendingDataRef.current = serializeGraphState(positions.op.unwrap(), graphView.op.unwrap());

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

		const unsubscribePositions = positions.op.subscribe(schedule);
		const unsubscribeGraphView = graphView.op.subscribe(schedule);

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
	}, [positions.op, graphView.op, main]);
}
