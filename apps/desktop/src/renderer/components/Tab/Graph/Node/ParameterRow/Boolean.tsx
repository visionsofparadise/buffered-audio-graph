import { Toggle } from "@buffered-audio/design-system";
export interface BooleanParameter {
	readonly kind: "boolean";
	readonly name: string;
	readonly value: boolean;
}

export function BooleanRow({
	param,
	dimmed,
	onParameterChange,
}: {
	readonly param: BooleanParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
	return (
		<div className={`flex items-center justify-between gap-3 ${dimmed ? "opacity-40" : ""}`}>
			<span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${dimmed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
				{param.name}
			</span>
			<Toggle
				value={param.value}
				onChange={onParameterChange ? (toggled) => onParameterChange(param.name, toggled) : undefined}
			/>
		</div>
	);
}
