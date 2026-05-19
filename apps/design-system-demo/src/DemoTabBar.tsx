import { IconButton, DropdownButton, type MenuItem } from "@buffered-audio/design-system";

interface Props {
	readonly tabs: ReadonlyArray<{ id: string; label: string }>;
	readonly activeTabId: string;
	readonly menuItems?: ReadonlyArray<MenuItem>;
}

export function DemoTabBar({ tabs, activeTabId, menuItems }: Props) {
	return (
		<div className="flex h-9 shrink-0 items-center gap-2 bg-void px-2">
			{menuItems && menuItems.length > 0 && (
				<DropdownButton
					trigger={<IconButton icon="lucide:menu" label="Menu" size={16} />}
					items={menuItems}
				/>
			)}

			<div className="h-4 w-px bg-chrome-border-subtle" />

			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId;

				return (
					<div
						key={tab.id}
						className={`flex items-center gap-2 ${
							isActive ? "bg-primary text-void" : "bg-chrome-raised text-chrome-text"
						}`}
					>
						<span className="font-body text-[length:var(--text-sm)]">{tab.label}</span>
						<IconButton icon="lucide:x" label="Close tab" size={10} dim />
					</div>
				);
			})}

			<IconButton
				icon="lucide:plus"
				label="New tab"
				active={!tabs.some((tab) => tab.id === activeTabId)}
				activeVariant="primary"
			/>
		</div>
	);
}
