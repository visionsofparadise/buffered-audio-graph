import { Download, LayoutGrid, Redo2, Save, Square, Undo2 } from "lucide-react";

/**
 * TopRightOverlay — graph-level toolbar.
 *
 * Auto-organize / Undo / Redo / Save / Render-Abort. Every button in the row
 * uses the same treatment as the home-screen actions: transparent against the
 * canvas, `text-body`, 16px icons, inverting to a white highlight on hover.
 * The toolbar reads as one uniform control group — RENDER is not a solid
 * primary button. The icon-only buttons use `p-2` so their height matches the
 * `py-2` text buttons; the whole row is a single consistent control set.
 */

const TOOLBAR_BUTTON = "flex items-center text-text-primary hover:bg-text-primary hover:text-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-primary";
const TEXT_BUTTON = `${TOOLBAR_BUTTON} w-fit gap-2 px-4 py-2 text-body`;
const ICON_BUTTON = `${TOOLBAR_BUTTON} justify-center p-2`;

interface Props {
	readonly onAutoOrganize: () => void;
	readonly onUndo: () => void;
	readonly onRedo: () => void;
	readonly onSave: () => void;
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
	onSave,
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
			<button type="button" className={TEXT_BUTTON} onClick={onSave}>
				<Save size={16} strokeWidth={1.5} />
				<span>Save</span>
			</button>
			{isRendering ? (
				<button type="button" className={TEXT_BUTTON} onClick={onAbort}>
					<Square size={16} strokeWidth={1.5} />
					<span>Abort</span>
				</button>
			) : (
				<button type="button" className={TEXT_BUTTON} onClick={onRender}>
					<Download size={16} strokeWidth={1.5} />
					<span>Render</span>
				</button>
			)}
		</div>
	);
}
