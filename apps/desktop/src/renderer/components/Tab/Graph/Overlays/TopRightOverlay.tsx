import { Download, LayoutGrid, Redo2, Square, Undo2 } from "lucide-react";

/**
 * TopRightOverlay — graph-level toolbar.
 *
 * Auto-organize / Undo / Redo as transparent icon buttons with hover inversion,
 * then RENDER as the accent action: 15px uppercase `text-accent-primary` with a
 * 20px `Download` glyph, inverting to an accent-background fill on hover. RENDER
 * swaps to Abort while a render runs. There is no Save button — the app menu's
 * Save plus the debounced `.bag` writer cover it.
 */

const ICON_BUTTON =
	"flex items-center justify-center p-2.5 text-text-primary hover:bg-text-primary hover:text-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-primary";
const RENDER_BUTTON =
	"flex w-fit items-center gap-2 px-6 py-3 text-[15px] uppercase tracking-[0.06em] text-accent-primary hover:bg-accent-primary hover:text-surface";

interface Props {
	readonly onAutoOrganize: () => void;
	readonly onUndo: () => void;
	readonly onRedo: () => void;
	readonly onRender: () => void;
	readonly onAbort: () => void;
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	readonly isRendering: boolean;
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
					<Square size={20} strokeWidth={1.5} />
					<span>Abort</span>
				</button>
			) : (
				<button type="button" className={RENDER_BUTTON} onClick={onRender}>
					<Download size={20} strokeWidth={1.5} />
					<span>Render</span>
				</button>
			)}
		</div>
	);
}
