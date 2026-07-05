import { IconButton } from "@buffered-audio/design-system";
import { cn } from "../../utils/cn";
import { Plus, X } from "lucide-react";
import type { AppContext } from "../../models/Context";
import { resnapshot } from "../../models/ProxyStore/resnapshot";
import { ProjectIcon } from "../ProjectIcon";
import { TabNameInput } from "./TabNameInput";

interface Props {
	readonly context: AppContext;
}

/**
 * AppTabBar — the lower chrome bar, directly below the title bar.
 *
 * Carries the open-graph tabs and the `+` Home button only — the app-menu
 * trigger lives in the title bar (see TitleBar.tsx). The bar is shorter than
 * the title bar, and its tabs / `+` are shorter still and bottom-aligned, so
 * they read as tabs belonging to the content area below rather than full-height
 * chrome cells. See design-app-shell.md "Tab Bar".
 */
export const AppTabBar = resnapshot<Props>(({ context }: Props) => {
	const { app, appStore } = context;

	const tabs = app.tabs.map((tab) => ({
		id: tab.id,
		label:
			context.tabNames.get(tab.id) ??
			tab.bagPath
				.split(/[\\/]/)
				.pop()
				?.replace(/\.bag$/i, "") ??
			tab.bagPath,
	}));

	const hasActiveGraphTab = app.activeTabId !== null;

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

		context.tabNames.delete(id);
	};

	const goHome = (): void => {
		appStore.mutate(app, (proxy) => {
			proxy.activeTabId = null;
		});
	};

	return (
		<div
			className="flex h-[40px] shrink-0 items-end bg-elevated"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
		>
			{tabs.map((tab) => {
				const isActive = tab.id === (app.activeTabId ?? "");

				return (
					<div
						key={tab.id}
						onClick={() => selectTab(tab.id)}
						style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
						className={cn(
							"group flex h-[34px] cursor-pointer items-center gap-2 px-4 text-body",
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
								"inline-flex items-center justify-center p-1",
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

			<IconButton
				icon={Plus}
				label="Home"
				variant="ghost"
				size="md"
				onClick={goHome}
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				className={cn("h-[34px]", !hasActiveGraphTab && "bg-text-primary text-surface hover:text-surface")}
			/>

			<div className="flex-1" />
		</div>
	);
});
