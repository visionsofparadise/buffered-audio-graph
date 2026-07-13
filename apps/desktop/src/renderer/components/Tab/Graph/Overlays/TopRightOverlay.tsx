import { Download, LayoutGrid, Redo2, Square, Undo2 } from "lucide-react";

/**
 * TopRightOverlay — graph-level toolbar.
 *
 * Auto-organize / Undo / Redo as transparent icon buttons with hover inversion,
 * then Render as the accent action: 13px `text-body` `text-accent-primary` with a
 * 16px `Download` glyph, inverting to an accent-background fill on hover. Render
 * swaps to Abort while a render runs. There is no Save button — the app menu's
 * Save plus the debounced `.bag` writer cover it.
 */

const ICON_BUTTON =
	"flex items-center justify-center p-2.5 text-text-primary hover:bg-text-primary hover:text-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-primary";
const RENDER_BUTTON =
	"flex w-fit items-center gap-2 px-4 py-2 text-body text-accent-primary hover:bg-accent-primary hover:text-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-accent-primary";

interface Props {
	readonly onAutoOrganize: () => void;
	readonly onUndo: () => void;
	readonly onRedo: () => void;
	readonly onRender: () => void;
	readonly onAbort: () => void;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	readonly isRendering: boolean;
	/** Render is enabled only when every pinned package pair in the bag is installed and ready. */
	readonly isRenderReady: boolean;
	/** Tooltip naming the not-ready pairs, shown when Render is gated closed. */
	readonly renderDisabledReason?: string;
}

export function TopRightOverlay({
	onAutoOrganize,
	onUndo,
	onRedo,
	onRender,
	onAbort,
	canUndo,
	canRedo,
	isRendering,
	isRenderReady,
	renderDisabledReason,
}: Props) {
	return (
		<div className="absolute right-3 top-3 z-10 flex items-center gap-2">
			<button type="button" aria-label="Auto-organize" className={ICON_BUTTON} onClick={onAutoOrganize}>
				<LayoutGrid size={16} strokeWidth={1.5} />
			</button>
			<button type="button" aria-label="Undo" className={ICON_BUTTON} disabled={!canUndo} onClick={onUndo}>
				<Undo2 size={16} strokeWidth={1.5} />
			</button>
			<button type="button" aria-label="Redo" className={ICON_BUTTON} disabled={!canRedo} onClick={onRedo}>
				<Redo2 size={16} strokeWidth={1.5} />
			</button>
			{isRendering ? (
				<button type="button" className={RENDER_BUTTON} onClick={onAbort}>
					<Square size={16} strokeWidth={1.5} />
					<span>Abort</span>
				</button>
			) : (
				<button
					type="button"
					className={RENDER_BUTTON}
					onClick={onRender}
					disabled={!isRenderReady}
					title={isRenderReady ? undefined : renderDisabledReason}
				>
					<Download size={16} strokeWidth={1.5} />
					<span>Render</span>
				</button>
			)}
		</div>
	);
}
