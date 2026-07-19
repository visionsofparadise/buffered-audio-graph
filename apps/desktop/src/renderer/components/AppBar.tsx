import { FilePlus, FolderOpen, Menu, Plus, Save, SaveAll, Settings, X } from "lucide-react";
import { cn } from "../utils/cn";
import { DropdownButton, type MenuItem } from "./DropdownButton";
import { IconButton } from "./IconButton";
import { ProjectIcon } from "./ProjectIcon";
import { TabNameInput } from "./TabNameInput";
import type { AppContext } from "../models/Context";
import { retrack } from "opshot/react";

interface Props {
	readonly context: AppContext;
	readonly chromeOnly?: boolean;
}

const DRAG = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/**
 * AppBar — the single 48px window chrome bar (design v1).
 *
 * One `h-12 bg-elevated` bar replacing the former title-bar + tab-bar pair. Left
 * to right: the app-menu trigger (full-height square), the open-graph tabs, the
 * `+` Home button, a flex spacer, and a 138px reservation for the native OS
 * caption buttons (`titleBarOverlay`). The bar is the window drag region; every
 * interactive child is `no-drag`. It renders in every app state, including the
 * package loading screen where only the menu trigger + reservation show (no
 * tabs), so the window is always draggable. See design-app-shell.md (2026-07-11).
 */
export const AppBar = retrack<Props>(({ context, chromeOnly = false }: Props) => {
	const { app, activeCommands } = context;
	const save = activeCommands.save;
	const hasActiveGraphTab = app.activeTabId !== null;

	const appMenuItems: ReadonlyArray<MenuItem> = [
		{ kind: "action", label: "New graph", icon: FilePlus, disabled: chromeOnly, onClick: () => void context.newBagTab() },
		{ kind: "action", label: "Open graph", icon: FolderOpen, disabled: chromeOnly, onClick: () => void context.openBagTab() },
		{ kind: "action", label: "Save", icon: Save, disabled: chromeOnly ? true : save === null, onClick: () => save?.() },
		{ kind: "action", label: "Save As", icon: SaveAll, disabled: true },
		{ kind: "separator" },
		{ kind: "action", label: "Settings", icon: Settings, disabled: chromeOnly, onClick: () => context.setSettingsOpen(true) },
		{ kind: "action", label: "Quit", icon: X, onClick: () => void context.main.quitApp() },
	];

	const tabs = app.tabs.map((tab) => ({
		id: tab.id,
		label:
			context.tabNames.names[tab.id] ??
			tab.bagPath
				.split(/[\\/]/)
				.pop()
				?.replace(/\.bag$/i, "") ??
			tab.bagPath,
	}));

	const visibleTabs = chromeOnly ? [] : tabs;

	const selectTab = (id: string): void => {
		app.mutate((mutable) => {
			mutable.activeTabId = id;
		});
	};

	const closeTab = (id: string): void => {
		app.mutate((mutable) => {
			const index = mutable.tabs.findIndex((tab) => tab.id === id);

			if (index === -1) return;
			mutable.tabs.splice(index, 1);

			if (mutable.activeTabId === id) {
				mutable.activeTabId = mutable.tabs[index]?.id ?? mutable.tabs[index - 1]?.id ?? null;
			}
		});

		context.tabNames.mutate((mutable) => {
			mutable.names = Object.fromEntries(Object.entries(mutable.names).filter(([tabId]) => tabId !== id));
		});
	};

	const goHome = (): void => {
		app.mutate((mutable) => {
			mutable.activeTabId = null;
		});
	};

	return (
		<div
			className="relative flex h-12 shrink-0 items-center bg-elevated"
			style={DRAG}
		>
			<div className="h-full" style={NO_DRAG}>
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

			{visibleTabs.map((tab) => {
				const isActive = tab.id === (app.activeTabId ?? "");

				return (
					<div
						key={tab.id}
						onClick={() => selectTab(tab.id)}
						style={NO_DRAG}
						className={cn(
							"group flex h-full cursor-pointer items-center gap-2 px-4 text-body",
							isActive ? "bg-text-primary text-surface" : "text-text-secondary hover:text-text-primary",
						)}
					>
						<ProjectIcon
							name={tab.label}
							size={16}
							className="mr-1"
						/>
						{isActive ? (
							<TabNameInput
								key={tab.label}
								tabId={tab.id}
								label={tab.label}
								onRename={context.renameTab}
							/>
						) : (
							<span
								className="max-w-[180px] truncate whitespace-nowrap"
								title={tab.label}
							>
								{tab.label}
							</span>
						)}
						<button
							type="button"
							aria-label={`Close ${tab.label}`}
							onClick={(event) => {
								event.stopPropagation();
								closeTab(tab.id);
							}}
							className={cn(
								"inline-flex items-center justify-center p-1 transition-opacity",
								isActive ? "text-surface hover:bg-surface/20" : "text-text-secondary hover:text-text-primary",
								isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							<X
								size={12}
								strokeWidth={1.5}
							/>
						</button>
					</div>
				);
			})}

			{!chromeOnly && (
				<IconButton
					icon={Plus}
					label="Home"
					variant="ghost"
					size="md"
					onClick={goHome}
					style={NO_DRAG}
					className={cn("h-full", !hasActiveGraphTab && "bg-text-primary text-surface hover:text-surface")}
				/>
			)}

			<div className="flex-1" />

			<div aria-hidden="true" className="h-full w-[138px]" />
		</div>
	);
});
