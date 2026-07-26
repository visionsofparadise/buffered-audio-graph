import type { State } from "opshot";
import { useEffect } from "react";
import type { Main } from "../Models/Main";
import type { MainEvents } from "../Models/MainEvents";
import type { AppState, WindowBounds } from "../Models/State/App";

export function useWindowState(app: State<AppState>, main: Main, mainEvents: MainEvents): void {
	useEffect(() => {
		const { windowBounds } = app.op.unwrap();

		if (windowBounds) {
			const { x, y, width, height } = windowBounds;

			void main.getAllDisplays().then((displays) => {
				const isVisible = displays.some(
					(display) =>
						x < display.x + display.width &&
						x + width > display.x &&
						y < display.y + display.height &&
						y + height > display.y,
				);

				if (isVisible) {
					void main.setBounds({ x, y, width, height });
				}
			});
		}

		const listener = (nextWindowBounds: WindowBounds): void => {
			app.mutate((mutable) => {
				mutable.windowBounds = nextWindowBounds;
			});
		};

		mainEvents.on("windowBoundsChanged", listener);

		return () => {
			mainEvents.off("windowBoundsChanged", listener);
		};
	}, [app.op, main, mainEvents]);
}
