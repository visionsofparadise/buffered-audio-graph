import { cn } from "../../../../../utils/cn";
import { FieldLabel } from "./FieldLabel";
import type { ReactNode } from "react";

export interface FieldRowParam {
	readonly name: string;
	readonly value: unknown;
	readonly optional: boolean;
	readonly defined: boolean;
}

export function FieldRow({
	param,
	dimmed,
	complete,
	title,
	className,
	controlClassName,
	controlDisabled,
	onControlDoubleClick,
	onParameterChange,
	onParameterUnset,
	children,
}: {
	readonly param: FieldRowParam;
	readonly dimmed?: boolean;
	readonly complete?: boolean;
	readonly title?: string;
	readonly className: string;
	readonly controlClassName: string;
	readonly controlDisabled?: boolean;
	readonly onControlDoubleClick?: () => void;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterUnset?: (name: string) => void;
	readonly children: ReactNode;
}) {
	const isControlDisabled = controlDisabled ?? (param.optional && !param.defined);
	const setDefinedHandler =
		onParameterChange || onParameterUnset
			? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
			: undefined;

	return (
		<div className={cn(className, dimmed && "opacity-40")} title={title}>
			<FieldLabel
				name={param.name}
				optional={param.optional}
				defined={param.defined}
				complete={complete}
				onSetDefined={setDefinedHandler}
			/>
			<div
				className={cn(controlClassName, isControlDisabled && "pointer-events-none opacity-40")}
				onDoubleClick={onControlDoubleClick}
			>
				{children}
			</div>
		</div>
	);
}
