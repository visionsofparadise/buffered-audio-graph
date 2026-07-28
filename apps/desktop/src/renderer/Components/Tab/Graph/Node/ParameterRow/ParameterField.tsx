import { cn } from "../../../../../utils/cn";
import { ArrayRow } from "./Array";
import { LeafField } from "./LeafField";
import { humanizeFieldName, paramLabelClass } from "./utils/labels";
import type { ObjectParameter, Parameter } from "../utils/buildParameters";
import type { ParameterCallbacks } from "./utils/callbacks";

export function ParameterField({
	param,
	basePath,
	dimmed,
	callbacks,
}: {
	readonly param: Parameter;
	readonly basePath: ReadonlyArray<string | number>;
	readonly dimmed?: boolean;
	readonly callbacks: ParameterCallbacks;
}) {
	switch (param.kind) {
		case "object":
			return <ObjectRow param={param} basePath={basePath} dimmed={dimmed} callbacks={callbacks} />;

		case "array":
			return <ArrayRow param={param} dimmed={dimmed} callbacks={callbacks} />;

		default: {
			const leafPath = [...basePath, param.name];

			return (
				<LeafField
					param={param}
					dimmed={dimmed}
					disabled={callbacks.disabled}
					onParameterChange={(_, value) => {
						callbacks.onParameterChangeAtPath?.(leafPath, value);
					}}
					onParameterBrowse={() => {
						callbacks.onParameterBrowseAtPath?.(leafPath);
					}}
					onParameterUnset={() => {
						callbacks.onParameterUnsetAtPath?.(leafPath);
					}}
					onFileOpen={callbacks.onFileOpen}
					statFile={callbacks.statFile}
					renderEpoch={callbacks.renderEpoch}
				/>
			);
		}
	}
}

function ObjectRow({
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
