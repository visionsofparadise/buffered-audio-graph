import { Icon } from "@iconify/react";
import { Button, IconButton } from "@buffered-audio/design-system";

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
		<div className="absolute right-3 top-3 z-10 flex items-center gap-3">
			<IconButton icon="lucide:layout-grid" label="Auto organize" onClick={onAutoOrganize} />
			<IconButton icon="lucide:undo-2" label="Undo" onClick={onUndo} disabled={!canUndo} />
			<IconButton icon="lucide:redo-2" label="Redo" onClick={onRedo} disabled={!canRedo} />
			{isRendering ? (
				<Button variant="secondary" size="xl" onClick={onAbort} className="text-state-error">
					<span className="flex items-center gap-2">
						<Icon icon="lucide:square" width={16} height={16} />
						<span>Abort</span>
					</span>
				</Button>
			) : (
				<Button variant="secondary" size="xl" onClick={onRender}>
					<span className="flex items-center gap-2">
						<Icon icon="lucide:play" width={16} height={16} />
						<span>Render</span>
					</span>
				</Button>
			)}
		</div>
	);
}
