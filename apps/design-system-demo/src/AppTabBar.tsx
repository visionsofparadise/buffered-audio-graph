import { useCallback, useEffect, useRef, useState } from "react";
import {
	FilePlus,
	FolderOpen,
	HardDrive,
	LogOut,
	Menu,
	Package,
	Plus,
	Save,
	SaveAll,
	Settings,
	X,
} from "lucide-react";
import {
	DropdownButton,
	IconButton,
	cn,
	type MenuItem,
} from "@buffered-audio/design-system";
import { ProjectIcon } from "./components/projectIcons";

export interface AppTab {
	readonly id: string;
	readonly name: string;
}

interface Props {
	/** `"home"` when the home screen is active, otherwise the id of an open-graph tab. */
	readonly activeTabId: string | null;
	/** Open-graph tabs only — Home is reached via the `+` button, not a tab. */
	readonly tabs: ReadonlyArray<AppTab>;
	readonly onSelectTab: (id: string) => void;
	readonly onCloseTab: (id: string) => void;
	/** Navigate to the home screen — bound to the `+` IconButton. */
	readonly onGoHome: () => void;
	readonly onRenameTab: (id: string, name: string) => void;
}

const APP_MENU_ITEMS: ReadonlyArray<MenuItem> = [
	{ kind: "action", label: "New graph", icon: FilePlus },
	{ kind: "action", label: "Open graph", icon: FolderOpen },
	{ kind: "action", label: "Save", icon: Save },
	{ kind: "action", label: "Save As", icon: SaveAll },
	{ kind: "separator" },
	{ kind: "action", label: "Manage Binaries", icon: HardDrive },
	{ kind: "action", label: "Manage Packages", icon: Package },
	{ kind: "separator" },
	{ kind: "action", label: "Preferences", icon: Settings },
	{ kind: "action", label: "Quit", icon: LogOut },
];

/**
 * AppTabBar — the BAG app's persistent chrome.
 *
 * Holds the app menu (left), a permanent Home tab, open `.bag`-file tabs, a
 * `+` add-tab trigger, a flex spacer, and reserved space for OS caption
 * buttons on the right. Modeled on spectrascope's `AppTabBar` but restyled
 * to the new warm-monochrome / Azeret direction.
 */
export function AppTabBar({
	activeTabId,
	tabs,
	onSelectTab,
	onCloseTab,
	onGoHome,
	onRenameTab,
}: Props) {
	const [editingTabId, setEditingTabId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const startEditing = useCallback((tabId: string, currentName: string) => {
		setEditingTabId(tabId);
		setEditingName(currentName);
	}, []);

	const commitRename = useCallback(() => {
		if (editingTabId && editingName.trim()) {
			onRenameTab(editingTabId, editingName.trim());
		}

		setEditingTabId(null);
		setEditingName("");
	}, [editingTabId, editingName, onRenameTab]);

	const cancelEditing = useCallback(() => {
		setEditingTabId(null);
		setEditingName("");
	}, []);

	useEffect(() => {
		if (editingTabId && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editingTabId]);

	// The home screen is not a tab — the `+` button reflects it as "active".
	const isHomeActive = activeTabId === "home";

	return (
		// `bg-elevated` lifts the chrome off the `bg-surface` workspace below.
		// No gap or padding — the menu, tabs, and `+` butt edge-to-edge for a
		// browser-style tab strip.
		<div className="flex h-12 shrink-0 items-center bg-elevated">
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
				items={APP_MENU_ITEMS}
			/>

			{/* Open-graph tabs. */}
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;
				const isEditing = editingTabId === tab.id;

				return (
					<div
						key={tab.id}
						onClick={() => {
							if (!isEditing) onSelectTab(tab.id);
						}}
						className={cn(
							"group flex h-full cursor-pointer items-center gap-2 px-4 text-body",
							isActive
								? "bg-text-primary text-surface"
								: "text-text-secondary hover:text-text-primary",
						)}
					>
						{/* Deterministic geometric mark for the project. */}
						<ProjectIcon name={tab.name} size={16} className="mr-1" />
						{isEditing ? (
							<input
								ref={inputRef}
								type="text"
								value={editingName}
								onChange={(event) => {
									setEditingName(event.target.value);
								}}
								onBlur={commitRename}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										commitRename();
									} else if (event.key === "Escape") {
										cancelEditing();
									}

									event.stopPropagation();
								}}
								onClick={(event) => {
									event.stopPropagation();
								}}
								className="w-32 bg-transparent text-body text-inherit outline-none"
							/>
						) : (
							<span
								className="max-w-[180px] truncate whitespace-nowrap"
								onDoubleClick={(event) => {
									event.stopPropagation();
									startEditing(tab.id, tab.name);
								}}
								title={tab.name}
							>
								{tab.name}
							</span>
						)}
						<button
							type="button"
							aria-label={`Close ${tab.name}`}
							onClick={(event) => {
								event.stopPropagation();
								onCloseTab(tab.id);
							}}
							className={cn(
								"inline-flex items-center justify-center p-1",
								isActive
									? "text-surface hover:bg-surface/20"
									: "text-text-secondary hover:text-text-primary",
								// Only surfaces on the active tab or while the tab is hovered.
								isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							<X size={12} strokeWidth={1.5} />
						</button>
					</div>
				);
			})}

			{/* Home button — opens the home screen, from which a new graph can be
			    created or an existing one opened. Highlights on hover and shows
			    the active-inversion when the home screen is open, exactly like a
			    tab. */}
			<IconButton
				icon={Plus}
				label="Home"
				variant="ghost"
				size="md"
				onClick={onGoHome}
				className={cn(
					"h-full",
					isHomeActive && "bg-text-primary text-surface hover:text-surface",
				)}
			/>

			<div className="flex-1" />

			{/* Reserved caption-button footprint — Electron paints OS controls here. */}
			<div aria-hidden="true" className="h-full w-[138px]" />
		</div>
	);
}
