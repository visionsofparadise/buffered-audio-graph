import { FileInput } from "@buffered-audio/design-system";
import { cn } from "../../../../../utils/cn";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";

export interface FileParameter {
	readonly kind: "file";
	readonly name: string;
	readonly value: string;
}

export function FileRow({
	param,
	dimmed,
	onParameterChange,
	onParameterBrowse,
}: {
	readonly param: FileParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterBrowse?: (name: string) => void;
}) {
	const complete = param.value !== "";

	return (
		<div className={cn("flex flex-col", dimmed && "opacity-40")}>
			<span className={cn(paramLabelClass(complete), "mb-1")}>{humanizeFieldName(param.name)}</span>
			<FileInput
				key={param.value}
				defaultValue={param.value}
				placeholder="No file selected"
				onChange={onParameterChange ? (next) => onParameterChange(param.name, next) : undefined}
				onBrowse={onParameterBrowse ? () => onParameterBrowse(param.name) : undefined}
			/>
		</div>
	);
}
