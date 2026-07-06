import {
	Blocks,
	FilePlus,
	FolderOpen,
	HardDrive,
	Menu,
	Redo2,
	Save,
	SaveAll,
	Undo2,
	X,
} from "lucide-react";
import { DropdownButton, IconButton, type MenuItem } from "@buffered-audio/design-system";
import type { AppContext } from "../models/Context";
import { resnapshot } from "../models/ProxyStore/resnapshot";

interface Props {
	readonly context: AppContext;
}

/**
 * TitleBar — the top chrome bar.
 *
 * A guaranteed window drag region, always present (including on the package
 * loading screen) so the window is draggable in every app state. It carries
 * the app-menu trigger at its left edge — flush, full-height — with an
 * absolutely-centered muted `BAGMAN` wordmark and a reserved OS caption-button
 * strip (`titleBarOverlay`) at the right edge. The rest of the bar is empty
 * draggable space.
 *
 * Two-bar chrome (title bar + tab bar) diverges from the design-system's
 * single-bar chrome — a desktop adaptation to OS window management so tabs
 * never sit under the native window controls. See design-app-shell.md.
 */
export const TitleBar = resnapshot<Props>(({ context }: Props) => {
	const { app, activeCommands } = context;
	const hasActiveGraphTab = app.activeTabId !== null;
	const save = activeCommands.save;

	const appMenuItems: ReadonlyArray<MenuItem> = [
		{
			kind: "action",
			label: "New Graph",
			icon: FilePlus,
			shortcut: "Ctrl+N",
			onClick: () => void context.newBagTab(),
		},
		{
			kind: "action",
			label: "Open Graph",
			icon: FolderOpen,
			shortcut: "Ctrl+O",
			onClick: () => void context.openBagTab(),
		},
		{
			kind: "action",
			label: "Save",
			icon: Save,
			shortcut: "Ctrl+S",
			disabled: save === null,
			onClick: () => save?.(),
		},
		{
			kind: "action",
			label: "Save As…",
			icon: SaveAll,
			shortcut: "Ctrl+Shift+S",
			disabled: !hasActiveGraphTab,
		},
		{ kind: "separator" },
		{
			kind: "action",
			label: "Undo",
			icon: Undo2,
			shortcut: "Ctrl+Z",
			disabled: !activeCommands.canUndo,
			onClick: () => activeCommands.undo?.(),
		},
		{
			kind: "action",
			label: "Redo",
			icon: Redo2,
			shortcut: "Ctrl+Shift+Z",
			disabled: !activeCommands.canRedo,
			onClick: () => activeCommands.redo?.(),
		},
		{ kind: "separator" },
		{
			kind: "action",
			label: "Package Manager",
			icon: Blocks,
			onClick: () => context.setPackageManagerOpen(true),
		},
		{
			kind: "action",
			label: "Binaries Manager",
			icon: HardDrive,
			onClick: () => context.setBinaryManagerOpen(true),
		},
		{ kind: "separator" },
		{
			kind: "action",
			label: "Close",
			icon: X,
			shortcut: "Ctrl+Q",
			onClick: () => void context.main.quitApp(),
		},
	];

	return (
		<div
			className="relative flex h-10 shrink-0 items-stretch bg-elevated"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
		>
			<div style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
				<DropdownButton
					trigger={
						<IconButton
							icon={Menu}
							label="App menu"
							variant="ghost"
							size="md"
							className="h-full data-[state=open]:bg-text-primary data-[state=open]:text-surface data-[state=open]:hover:text-surface"
						/>
					}
					items={appMenuItems}
				/>
			</div>

			<div className="flex-1" />

			<span className="type-display text-body text-dimmed pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none">
				BAGMAN
			</span>

			<div aria-hidden="true" className="w-[138px]" />
		</div>
	);
});
