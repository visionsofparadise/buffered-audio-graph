import { Download, LayoutGrid, Redo2, Square, Undo2 } from "lucide-react";
import { Button, IconButton } from "@buffered-audio/design-system";

/**
 * TopRightOverlay — graph-level toolbar.
 *
 * Auto-organize / Undo / Redo / Render-Abort. Every button in the row uses
 * the same treatment as the home-screen actions: transparent against the
 * canvas, inverting to a white highlight on hover.
 */

// Home-screen-button treatment: no chrome at rest, active-inversion on hover.
const TOOLBAR_BUTTON = "text-text-primary hover:bg-text-primary hover:text-surface";

interface Props {
	readonly isRendering: boolean;
	readonly onAutoOrganize: () => void;
	readonly onUndo: () => void;
	readonly onRedo: () => void;
	readonly onRender: () => void;
	readonly onAbort: () => void;
}

export function TopRightOverlay({
	isRendering,
	onAutoOrganize,
	onUndo,
	onRedo,
	onRender,
	onAbort,
}: Props) {
	return (
		<div className="absolute right-3 top-3 z-10 flex items-center gap-2">
			<IconButton icon={LayoutGrid} label="Auto-organize" variant="ghost" size="md" className={TOOLBAR_BUTTON} onClick={onAutoOrganize} />
			<IconButton icon={Undo2} label="Undo" variant="ghost" size="md" className={TOOLBAR_BUTTON} onClick={onUndo} />
			<IconButton icon={Redo2} label="Redo" variant="ghost" size="md" disabled className="hover:text-dimmed" onClick={onRedo} />
			{isRendering ? (
				<Button variant="ghost" size="lg" icon={Square} className={TOOLBAR_BUTTON} onClick={onAbort}>
					ABORT
				</Button>
			) : (
				<Button variant="ghost" size="lg" icon={Download} className={TOOLBAR_BUTTON} onClick={onRender}>
					RENDER
				</Button>
			)}
		</div>
	);
}
