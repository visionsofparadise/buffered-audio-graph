import { Button } from "@buffered-audio/design-system";
export interface FileParameter {
	readonly kind: "file";
	readonly name: string;
	readonly value: string;
}

export function FileRow({
	param,
	dimmed,
	onParameterBrowse,
}: {
	readonly param: FileParameter;
	readonly dimmed?: boolean;
	readonly onParameterBrowse?: (name: string) => void;
}) {
	return (
		<div className={`flex flex-col gap-1 ${dimmed ? "opacity-40" : ""}`}>
			<span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${dimmed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
				{param.name}
			</span>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate font-body text-[length:var(--text-xs)] text-chrome-text">
					{param.value ? param.value.split(/[/\\]/).pop() : "No file selected"}
				</span>
				<Button
					size="sm"
					variant="secondary"
					onClick={() => onParameterBrowse?.(param.name)}
					disabled={!onParameterBrowse}
				>
					Browse
				</Button>
			</div>
		</div>
	);
}
