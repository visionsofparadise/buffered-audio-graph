import { ButtonSelection, Select } from "@buffered-audio/design-system";
export interface EnumParameter {
	readonly kind: "enum";
	readonly name: string;
	readonly value: string;
	readonly options: ReadonlyArray<string>;
}

export function EnumRow({
	param,
	dimmed,
	onParameterChange,
}: {
	readonly param: EnumParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
}) {
	const useButtons = param.options.every((opt) => opt.length <= 10);

	return (
		<div className={`flex flex-col gap-1 ${dimmed ? "opacity-40" : ""}`}>
			<span className={`font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] ${dimmed ? "text-chrome-text-dim" : "text-chrome-text-secondary"}`}>
				{param.name}
			</span>
			{useButtons ? (
				<ButtonSelection
					active={param.value}
					options={param.options}
					onSelect={onParameterChange ? (option) => onParameterChange(param.name, option) : undefined}
				/>
			) : (
				<Select
					value={param.value}
					options={param.options}
					onSelect={onParameterChange ? (option) => onParameterChange(param.name, option) : undefined}
				/>
			)}
		</div>
	);
}
