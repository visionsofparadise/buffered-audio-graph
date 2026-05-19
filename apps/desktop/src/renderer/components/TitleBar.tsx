import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
} from "@buffered-audio/design-system";
import { Icon } from "@iconify/react";
import type { AppContext } from "../models/Context";

interface Props {
	readonly context: AppContext;
}

function AppMenuItem({ icon, label, shortcut, onSelect, disabled }: {
	readonly icon: string;
	readonly label: string;
	readonly shortcut?: string;
	readonly onSelect?: () => void;
	readonly disabled?: boolean;
}) {
	return (
		<DropdownMenuItem
			disabled={disabled}
			onSelect={() => onSelect?.()}
		>
			<Icon icon={icon} width={12} height={12} className="shrink-0" />
			<span className="flex-1">{label}</span>
			{shortcut && <span className="shrink-0 text-[length:var(--text-xs)] normal-case tracking-normal text-chrome-text-dim">{shortcut}</span>}
		</DropdownMenuItem>
	);
}

export function TitleBar({ context }: Props) {
	const hasActiveGraphTab = context.app.activeTabId !== null;

	return (
		<div
			className="relative h-[45px] w-full shrink-0 bg-chrome-base pr-[138px]"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
		>
			<div
				className="absolute left-2 top-1/2 -translate-y-1/2"
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<IconButton icon="lucide:menu" label="Menu" size={16} />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<AppMenuItem icon="lucide:file-plus" label="New Graph" shortcut="Ctrl+N" onSelect={() => void context.newBagTab()} />
						<AppMenuItem icon="lucide:folder-open" label="Open Graph" shortcut="Ctrl+O" onSelect={() => void context.openBagTab()} />
						<AppMenuItem icon="lucide:import" label="Import Bag" shortcut="Ctrl+Shift+O" onSelect={() => void context.importBagIntoActiveTab()} disabled={!hasActiveGraphTab} />
						<AppMenuItem icon="lucide:save" label="Save" shortcut="Ctrl+S" disabled={!hasActiveGraphTab} />
						<AppMenuItem icon="lucide:save-all" label="Save As…" shortcut="Ctrl+Shift+S" disabled={!hasActiveGraphTab} />
						<DropdownMenuSeparator />
						<AppMenuItem icon="lucide:blocks" label="Package Manager" onSelect={context.openModuleManager} />
						<AppMenuItem icon="lucide:hard-drive" label="Binaries Manager" onSelect={context.openBinaryManager} />
						<DropdownMenuSeparator />
						<AppMenuItem icon="lucide:settings" label="Settings" shortcut="Ctrl+," />
						<DropdownMenuSeparator />
						<AppMenuItem icon="lucide:x" label="Close" shortcut="Ctrl+Q" onSelect={() => void context.main.quitApp()} />
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none font-display font-bold leading-none tracking-tight text-chrome-text text-[length:var(--text-sm)]">
				ENGINEERING
			</span>
		</div>
	);
}
