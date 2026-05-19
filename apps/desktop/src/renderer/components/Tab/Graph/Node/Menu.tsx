import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	IconButton,
} from "@buffered-audio/design-system";
import { Icon } from "@iconify/react";

export function NodeMenu({ isSource, isProcessing, isPending, isBypassed, isInspected, onRender, onAbort }: {
	readonly isSource: boolean;
	readonly isProcessing: boolean;
	readonly isPending: boolean;
	readonly isBypassed: boolean;
	readonly isInspected: boolean;
	readonly onRender?: () => void;
	readonly onAbort?: () => void;
}) {
	let renderLabel = "Render";
	let renderColor = "text-chrome-text";

	if (isProcessing) { renderLabel = "Abort"; renderColor = "text-state-error"; }
	else if (isPending) { renderLabel = "Pending"; renderColor = "text-chrome-text-dim"; }

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<IconButton icon="lucide:ellipsis-vertical" label="Node menu" dim />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{isSource && (
					<DropdownMenuItem className={isInspected ? "text-primary" : undefined}>
						<Icon icon="lucide:eye" width={12} height={12} className="shrink-0" />
						<span>Inspect</span>
					</DropdownMenuItem>
				)}

				{!isSource && (
					<DropdownMenuItem
						className={renderColor}
						onSelect={() => (isProcessing ? onAbort?.() : onRender?.())}
					>
						<Icon icon={isProcessing ? "lucide:square" : "lucide:play"} width={12} height={12} className="shrink-0" />
						<span>{renderLabel}</span>
					</DropdownMenuItem>
				)}

				<DropdownMenuItem className={isBypassed ? "text-secondary" : undefined}>
					<Icon icon="lucide:power" width={12} height={12} className="shrink-0" />
					<span>{isBypassed ? "Enable" : "Bypass"}</span>
				</DropdownMenuItem>

				<DropdownMenuSeparator />

				<DropdownMenuItem className="text-state-error">
					<Icon icon="lucide:trash-2" width={12} height={12} className="shrink-0" />
					<span>Delete</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
