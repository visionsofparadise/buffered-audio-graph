import type { Parameter } from "../utils/buildParameters";
import { ArrayRow } from "./Array";
import { LeafField } from "./LeafField";
import { ObjectRow } from "./Object";

/**
 * Callbacks passed through the recursive parameter renderer.
 * All are optional — missing callbacks disable the relevant controls.
 */
export interface ParameterCallbacks {
	/** Called when any leaf value changes. Path is [topLevelName, ...nested]. */
	readonly onParameterChangeAtPath?: (path: ReadonlyArray<string | number>, value: unknown) => void;
	/** Called when an optional leaf is toggled to AUTO — the key is deleted. Path is [topLevelName, ...nested]. */
	readonly onParameterUnsetAtPath?: (path: ReadonlyArray<string | number>) => void;
	/** Called when a file/folder leaf requests a browse dialog. */
	readonly onParameterBrowseAtPath?: (path: ReadonlyArray<string | number>) => void;
	/** Called when a new array row should be appended. */
	readonly onArrayRowAdd?: (paramName: string) => void;
	/** Called when an array row should be removed. */
	readonly onArrayRowDelete?: (paramName: string, rowIndex: number) => void;
	/** Called when array rows should be reordered. */
	readonly onArrayRowReorder?: (paramName: string, fromIndex: number, toIndex: number) => void;
	/** Open a save-mode file param's current value in the OS default app. */
	readonly onFileOpen?: (value: string) => void;
	/** Resolves true when a file value names an existing file — drives the open-output button. */
	readonly statFile?: (value: string) => Promise<boolean>;
	/** Bumped when a render completes, re-triggering the open-output existence check. */
	readonly renderEpoch?: number;
	/** When true, number knobs render as disabled (no callbacks available). */
	readonly disabled?: boolean;
}

/**
 * Recursive parameter renderer. Dispatches on Parameter kind and passes
 * path context down to leaf controls so they emit the correct path.
 */
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
			return (
				<ObjectRow
					param={param}
					basePath={basePath}
					dimmed={dimmed}
					callbacks={callbacks}
				/>
			);

		case "array":
			return (
				<ArrayRow
					param={param}
					dimmed={dimmed}
					callbacks={callbacks}
				/>
			);

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
