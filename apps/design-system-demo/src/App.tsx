import { useState } from "react";
import { AppTabBar, type AppTab } from "./AppTabBar";
import { DemoViewSwitch, type DemoView } from "./DemoViewSwitch";
import { HomePage } from "./pages/HomePage";
import { ShowcasePage } from "./pages/ShowcasePage";
import { GraphPage } from "./pages/GraphPage";

const INITIAL_TABS: ReadonlyArray<AppTab> = [
	{ id: "tab-1", name: "Podcast Episode 042" },
	{ id: "tab-2", name: "Album Pre-Master" },
];

export function App() {
	const [view, setView] = useState<DemoView>("app");
	const [activeTabId, setActiveTabId] = useState<string | null>("home");
	const [tabs, setTabs] = useState<ReadonlyArray<AppTab>>(INITIAL_TABS);

	const handleSelectTab = (id: string) => {
		setActiveTabId(id);
	};

	const handleCloseTab = (id: string) => {
		setTabs((current) => {
			const index = current.findIndex((tab) => tab.id === id);

			if (index === -1) return current;

			const next = current.filter((tab) => tab.id !== id);

			if (activeTabId === id) {
				// Fall back to the tab that was before the closed one, or the next
				// remaining tab, or the home tab if no graph tabs remain.
				const fallback = next[index - 1]?.id ?? next[index]?.id ?? "home";

				setActiveTabId(fallback);
			}

			return next;
		});
	};

	const handleGoHome = () => {
		setActiveTabId("home");
	};

	const handleNewGraph = () => {
		const freshId = `tab-${Date.now()}`;

		setTabs((current) => [...current, { id: freshId, name: "Untitled" }]);
		setActiveTabId(freshId);
	};

	const handleOpenGraph = () => {
		// In the desktop app this opens an OS file picker; the demo creates a
		// placeholder tab so the home → graph flow can still be exercised.
		const freshId = `tab-${Date.now()}`;

		setTabs((current) => [...current, { id: freshId, name: "Opened graph" }]);
		setActiveTabId(freshId);
	};

	const handleOpenRecent = (name: string) => {
		const freshId = `tab-${Date.now()}`;

		setTabs((current) => [...current, { id: freshId, name }]);
		setActiveTabId(freshId);
	};

	const handleRenameTab = (id: string, name: string) => {
		setTabs((current) =>
			current.map((tab) => (tab.id === id ? { ...tab, name } : tab)),
		);
	};

	return (
		<div className="flex h-screen w-screen flex-col bg-surface text-text-primary">
			<DemoViewSwitch view={view} onChange={setView} />
			{view === "app" && (
				<AppTabBar
					activeTabId={activeTabId}
					tabs={tabs}
					onSelectTab={handleSelectTab}
					onCloseTab={handleCloseTab}
					onGoHome={handleGoHome}
					onRenameTab={handleRenameTab}
				/>
			)}
			<main className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{view === "app" ? (
					activeTabId === "home" ? (
						<HomePage
							onNewGraph={handleNewGraph}
							onOpenGraph={handleOpenGraph}
							onOpenRecent={handleOpenRecent}
						/>
					) : (
						<GraphPage />
					)
				) : (
					<ShowcasePage />
				)}
			</main>
		</div>
	);
}
