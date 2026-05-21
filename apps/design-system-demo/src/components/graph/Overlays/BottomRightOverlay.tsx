import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { IconButton } from "@buffered-audio/design-system";

/**
 * BottomRightOverlay — render-progress toast.
 *
 * Per the design-components.md "Toasts" section: render jobs surface as a
 * cancellable toast in the bottom-right of the workspace. In the demo, a
 * single mock toast animates a progress bar from 0 → 100% over ~12 seconds
 * and then loops, so the visual treatment can be reviewed without wiring a
 * real render pipeline.
 */
export function BottomRightOverlay() {
	const [progress, setProgress] = useState(0.12);

	useEffect(() => {
		const id = setInterval(() => {
			setProgress((current) => {
				const next = current + 0.02;

				return next >= 1 ? 0 : next;
			});
		}, 250);

		return () => {
			clearInterval(id);
		};
	}, []);

	const percent = Math.round(progress * 100);

	return (
		<div className="absolute bottom-3 right-3 z-10 flex w-72 flex-col gap-2 rounded-xs border border-border bg-elevated px-4 py-3">
			<div className="flex items-center justify-between gap-2">
				<span className="type-label text-text-secondary">Render</span>
				<IconButton
					icon={X}
					label="Cancel render"
					size="sm"
					onClick={() => {
						// no-op for the demo
					}}
				/>
			</div>
			<span className="text-body text-text-primary">podcast-final.wav</span>
			<div className="h-1 w-full overflow-hidden rounded-xs bg-surface">
				<div
					className="h-full bg-text-primary transition-[width] duration-200"
					style={{ width: `${percent}%` }}
				/>
			</div>
			<div className="flex items-center justify-between">
				<span className="type-label text-text-secondary">In progress</span>
				<span className="type-label tabular-nums text-text-secondary">{percent}%</span>
			</div>
		</div>
	);
}
