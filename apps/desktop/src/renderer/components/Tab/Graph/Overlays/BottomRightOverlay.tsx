import { X } from "lucide-react";
import { cn } from "../../../../utils/cn";
import { IconButton } from "../../../IconButton";

/**
 * BottomRightOverlay — render-progress toast.
 *
 * Per `design-components.md` "Toasts": an active render job surfaces as a
 * cancellable `bg-elevated` toast in the bottom-right of the workspace. The
 * toast renders while a render job is in progress or a render has failed; when
 * neither is true it renders nothing. Progress is the aggregate render progress
 * across the graph's processing nodes; the job is identified by the graph name.
 * A failed render switches the bar fill to `error` and shows the error message
 * (core's leaf-validation / missing-package error) in 13px `error` body text;
 * the cancel `×` dismisses the error or aborts the running render.
 */

interface Props {
	readonly isRendering: boolean;
	/** Non-null when the last render rejected — its message is shown in the toast. */
	readonly renderError: string | null;
	readonly graphName: string;
	/** Aggregate render progress, 0–1. */
	readonly progress: number;
	/** Abort the running render (if any) and clear a shown error. */
	readonly onDismiss: () => void;
}

export function BottomRightOverlay({ isRendering, renderError, graphName, progress, onDismiss }: Props) {
	if (!isRendering && renderError === null) return null;

	const hasError = renderError !== null;
	const percent = Math.round(progress * 100);

	return (
		<div className="absolute bottom-3 right-3 z-10 flex w-72 flex-col gap-2 rounded-xs bg-elevated px-4 py-3 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
			<div className="flex items-center justify-between gap-2">
				<span className="type-label text-text-secondary">Render</span>
				<IconButton icon={X} label={hasError ? "Dismiss" : "Cancel render"} variant="ghost" size="sm" onClick={onDismiss} />
			</div>
			<span className="text-body text-text-primary">{graphName}</span>
			{hasError && <span className="text-body text-error">{renderError}</span>}
			<div className="h-1 w-full overflow-hidden rounded-xs bg-surface">
				<div
					className={cn("h-full transition-[width] duration-200", hasError ? "bg-error" : "bg-accent-primary")}
					style={{ width: `${String(hasError ? 100 : percent)}%` }}
				/>
			</div>
			<div className="flex items-center justify-between">
				<span className={cn("type-label", hasError ? "text-error" : "text-text-secondary")}>
					{hasError ? "Failed" : "In progress"}
				</span>
				{!hasError && <span className="type-label tabular-nums text-text-secondary">{percent}%</span>}
			</div>
		</div>
	);
}
