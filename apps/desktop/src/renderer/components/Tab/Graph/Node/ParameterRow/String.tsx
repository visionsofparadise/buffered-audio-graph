import { useEffect, useRef, useState } from "react";
import { Input } from "../../../../Input";
import { cn } from "../../../../../utils/cn";
import { FieldLabel } from "./FieldLabel";

export interface StringParameter {
	readonly kind: "string";
	readonly name: string;
	readonly value: string;
	readonly optional: boolean;
	readonly defined: boolean;
}

export function StringRow({
	param,
	dimmed,
	onParameterChange,
	onParameterUnset,
}: {
	readonly param: StringParameter;
	readonly dimmed?: boolean;
	readonly onParameterChange?: (name: string, value: unknown) => void;
	readonly onParameterUnset?: (name: string) => void;
}) {
	const [local, setLocal] = useState(param.value);
	// Same-tick input+blur (e.g. smoke helper) commits before setState re-renders.
	const localRef = useRef(param.value);

	useEffect(() => {
		localRef.current = param.value;
		setLocal(param.value);
	}, [param.value]);

	const controlDisabled = param.optional && !param.defined;
	const setDefinedHandler = onParameterChange || onParameterUnset
		? (next: boolean) => (next ? onParameterChange?.(param.name, param.value) : onParameterUnset?.(param.name))
		: undefined;

	const updateLocal = (next: string): void => {
		localRef.current = next;
		setLocal(next);
	};

	const commit = (): void => {
		const next = localRef.current;

		if (next === param.value) return;

		onParameterChange?.(param.name, next);
	};

	return (
		<div className={cn("flex flex-col", dimmed && "opacity-40")}>
			<FieldLabel
				name={param.name}
				optional={param.optional}
				defined={param.defined}
				onSetDefined={setDefinedHandler}
			/>
			<div className={cn("mt-1", controlDisabled && "pointer-events-none opacity-40")}>
				<Input
					type="text"
					value={local}
					onChange={onParameterChange ? updateLocal : undefined}
					onBlur={onParameterChange ? commit : undefined}
					onKeyDown={
						onParameterChange
							? (event) => {
									if (event.key === "Enter") {
										event.currentTarget.blur();
									}
								}
							: undefined
					}
					className="w-full"
				/>
			</div>
		</div>
	);
}
