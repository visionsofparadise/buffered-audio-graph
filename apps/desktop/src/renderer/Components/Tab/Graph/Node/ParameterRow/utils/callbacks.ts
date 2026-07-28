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
