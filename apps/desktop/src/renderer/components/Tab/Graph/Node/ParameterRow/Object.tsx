import { cn } from "../../../../../utils/cn";
import type { ObjectParameter } from "../utils/buildParameters";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";
import type { ParameterCallbacks } from "./ParameterField";
import { ParameterField } from "./ParameterField";

/** Always-expanded container for nested object parameters. No collapse toggle. */
export function ObjectRow({
	param,
	basePath,
	dimmed,
	callbacks,
}: {
	readonly param: ObjectParameter;
	readonly basePath: ReadonlyArray<string | number>;
	readonly dimmed?: boolean;
	readonly callbacks: ParameterCallbacks;
}) {
	const childPath = [...basePath, param.name];

	return (
		<div className={cn("flex flex-col gap-4", dimmed && "opacity-40")}>
			<span className={paramLabelClass(true)}>{humanizeFieldName(param.name)}</span>
			<div className="flex flex-col gap-4">
				{param.children.map((child) => (
					<ParameterField
						key={child.name}
						param={child}
						basePath={childPath}
						dimmed={dimmed}
						callbacks={callbacks}
					/>
				))}
			</div>
		</div>
	);
}
