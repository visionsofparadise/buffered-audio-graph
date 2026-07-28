import type { Parameter } from "../utils/buildParameters";
import { ArrayRow } from "./Array";
import { LeafField } from "./LeafField";
import { ObjectRow } from "./Object";

export interface ParameterCallbacks {
	readonly onParameterChangeAtPath?: (path: ReadonlyArray<string | number>, value: unknown) => void;
	readonly onParameterUnsetAtPath?: (path: ReadonlyArray<string | number>) => void;
	readonly onParameterBrowseAtPath?: (path: ReadonlyArray<string | number>) => void;
	readonly onArrayRowAdd?: (paramName: string) => void;
	readonly onArrayRowDelete?: (paramName: string, rowIndex: number) => void;
	readonly onArrayRowReorder?: (paramName: string, fromIndex: number, toIndex: number) => void;
	readonly onFileOpen?: (value: string) => void;
	readonly statFile?: (value: string) => Promise<boolean>;
	readonly renderEpoch?: number;
	readonly disabled?: boolean;
}

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
