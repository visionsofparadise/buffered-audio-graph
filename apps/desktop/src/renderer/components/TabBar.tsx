import { useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "@buffered-audio/design-system";
import type { AppContext } from "../models/Context";

interface Props {
	readonly context: AppContext;
}

export function AppTabBar({ context }: Props) {
	const { app, appStore } = context;

	const [editingTabId, setEditingTabId] = useState<string | null>(null);
	const [editingName, setEditingName] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const tabs = app.tabs.map((tab) => ({
		id: tab.id,
		label: context.tabNames.get(tab.id) ?? tab.bagPath.split(/[\\/]/).pop()?.replace(/\.bag$/i, "") ?? tab.bagPath,
	}));

	const selectTab = (id: string): void => {
		appStore.mutate(app, (proxy) => {
			proxy.activeTabId = id;
		});
	};

	const closeTab = (id: string): void => {
		appStore.mutate(app, (proxy) => {
			const index = proxy.tabs.findIndex((tab) => tab.id === id);

			if (index === -1) return;
			proxy.tabs.splice(index, 1);

			if (proxy.activeTabId === id) {
				proxy.activeTabId = proxy.tabs[index]?.id ?? proxy.tabs[index - 1]?.id ?? null;
			}
		});

		context.historyStacks.delete(id);
		context.tabNames.delete(id);
		context.renameCallbacks.delete(id);
		context.importCallbacks.delete(id);
		context.undoCallbacks.delete(id);
		context.redoCallbacks.delete(id);
	};

	const startEditing = useCallback((tabId: string, currentLabel: string) => {
		setEditingTabId(tabId);
		setEditingName(currentLabel);
	}, []);

	const commitRename = useCallback(() => {
		if (editingTabId && editingName.trim()) {
			context.renameTab(editingTabId, editingName.trim());
		}

		setEditingTabId(null);
		setEditingName("");
	}, [editingTabId, editingName, context]);

	const cancelEditing = useCallback(() => {
		setEditingTabId(null);
		setEditingName("");
	}, []);

	// Focus the input when editing starts
	useEffect(() => {
		if (editingTabId && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [editingTabId]);

	return (
		<div className="flex h-9 shrink-0 items-center gap-2 bg-void px-2">
			<div className="h-4 w-px bg-chrome-border-subtle" />

			{tabs.map((tab) => {
				const isActive = tab.id === (app.activeTabId ?? "");
				const isEditing = editingTabId === tab.id;

				return (
					<div
						key={tab.id}
						className={`flex items-center gap-2 ${
							isActive ? "bg-primary text-void" : "bg-chrome-raised text-chrome-text"
						}`}
						onClick={() => selectTab(tab.id)}
					>
						{isEditing ? (
							<input
								ref={inputRef}
								type="text"
								value={editingName}
								onChange={(event) => setEditingName(event.target.value)}
								onBlur={commitRename}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										commitRename();
									} else if (event.key === "Escape") {
										cancelEditing();
									}

									event.stopPropagation();
								}}
								onClick={(event) => event.stopPropagation()}
								className="w-32 bg-transparent font-body text-[length:var(--text-sm)] text-inherit outline-none"
							/>
						) : (
							<span
								className="font-body text-[length:var(--text-sm)]"
								onDoubleClick={(event) => {
									event.stopPropagation();
									startEditing(tab.id, tab.label);
								}}
							>
								{tab.label}
							</span>
						)}
						<IconButton icon="lucide:x" label="Close tab" size={10} dim onClick={() => closeTab(tab.id)} />
					</div>
				);
			})}

			<IconButton
				icon="lucide:plus"
				label="Home"
				active={app.activeTabId === null}
				activeVariant="primary"
				onClick={() =>
					appStore.mutate(app, (proxy) => {
						proxy.activeTabId = null;
					})
				}
			/>
		</div>
	);
}
