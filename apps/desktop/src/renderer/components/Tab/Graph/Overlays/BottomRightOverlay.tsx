import { X } from "lucide-react";
import { IconButton } from "@buffered-audio/design-system";

/**
 * BottomRightOverlay — render-progress toast.
 *
 * Per `design-components.md` "Toasts": an active render job surfaces as a
 * cancellable `bg-elevated` toast in the bottom-right of the workspace. The
 * toast renders only while a render job is in progress; when no job is active
 * it renders nothing. Progress is the aggregate render progress across the
 * graph's processing nodes; the job is identified by the graph name.
 */

interface Props {
	readonly isRendering: boolean;
	readonly graphName: string;
	/** Aggregate render progress, 0–1. */
	readonly progress: number;
	readonly onAbort: () => void;
}

export function BottomRightOverlay({ isRendering, graphName, progress, onAbort }: Props) {
	if (!isRendering) return null;

	const percent = Math.round(progress * 100);

	return (
		<div className="absolute bottom-3 right-3 z-10 flex w-72 flex-col gap-2 rounded-xs border border-border bg-elevated px-4 py-3">
			<div className="flex items-center justify-between gap-2">
				<span className="type-label text-text-secondary">Render</span>
				<IconButton icon={X} label="Cancel render" variant="ghost" size="sm" onClick={onAbort} />
			</div>
			<span className="text-body text-text-primary">{graphName}</span>
			<div className="h-1 w-full overflow-hidden rounded-xs bg-surface">
				<div
					className="h-full bg-text-primary transition-[width] duration-200"
					style={{ width: `${String(percent)}%` }}
				/>
			</div>
			<div className="flex items-center justify-between">
				<span className="type-label text-text-secondary">In progress</span>
				<span className="type-label tabular-nums text-text-secondary">{percent}%</span>
			</div>
		</div>
	);
}
