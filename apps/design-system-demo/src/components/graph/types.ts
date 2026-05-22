/**
 * Node-data types for the design-system demo graph.
 *
 * Three categories — `source` / `transform` / `target` — encode port asymmetry
 * at the type level: a source has no inputs, a target has no outputs.
 *
 * Each param carries its own `complete` flag so the node can surface attention
 * at param-row granularity: an incomplete param renders its label in
 * `accent-primary` (a coral label on the specific incomplete param). There is
 * no panel-level attention treatment.
 */

export type NodeCategory = "source" | "transform" | "target";

export type ParamType =
	| "knob"
	| "fader"
	| "toggle"
	| "buttonSelection"
	| "select"
	| "input"
	| "file"
	| "objectArray";

export interface NumberParam {
	readonly type: "knob" | "fader";
	readonly value: number;
	readonly complete: boolean;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	readonly unit?: string;
}

export interface ToggleParam {
	readonly type: "toggle";
	readonly value: boolean;
	readonly complete: boolean;
}

export interface SelectParam {
	readonly type: "buttonSelection" | "select";
	readonly value: string;
	readonly complete: boolean;
	readonly options: ReadonlyArray<string>;
}

export interface InputParam {
	readonly type: "input";
	readonly value: string;
	readonly complete: boolean;
}

/**
 * A text param whose value is a filesystem path — a schema string field
 * annotated `.meta({ input: "file" })`. Rendered with a browse affordance
 * rather than a plain text field. `accept` / `mode` mirror the schema meta.
 */
export interface FileParam {
	readonly type: "file";
	readonly value: string;
	readonly complete: boolean;
	/** File-extension filter from the schema meta, e.g. ".vst3". */
	readonly accept?: string;
	/** Whether the picker opens an existing file or names a new one. */
	readonly mode?: "open" | "save";
}

/**
 * A param that is an array of sub-forms — a schema `z.array(z.object(...))`
 * field (e.g. the VST3 node's `stages`). Each element is itself a set of
 * params; the array is edited by adding / removing elements.
 */
export interface ObjectArrayParam {
	readonly type: "objectArray";
	readonly value: ReadonlyArray<Readonly<Record<string, Param>>>;
	readonly complete: boolean;
	/** Singular noun for one element, e.g. "Stage" — used on headers and the add button. */
	readonly itemNoun: string;
	/** Field shape for a freshly-added element. */
	readonly itemTemplate: Readonly<Record<string, Param>>;
}

export type Param =
	| NumberParam
	| ToggleParam
	| SelectParam
	| InputParam
	| FileParam
	| ObjectArrayParam;

export interface PortDef {
	readonly id: string;
	/** Required inputs that aren't connected render as coral. Outputs ignore this. */
	readonly required?: boolean;
}

interface BaseNodeData {
	readonly name: string;
	readonly bypassed?: boolean;
	readonly parameters: Readonly<Record<string, Param>>;
	/**
	 * Currently-connected input port ids — drives the `bg-text-primary` handle color.
	 */
	readonly connectedInputs?: ReadonlyArray<string>;
	/**
	 * Currently-connected output port ids — drives the `bg-text-primary` handle color.
	 */
	readonly connectedOutputs?: ReadonlyArray<string>;
	/**
	 * Optional fixed panel width in px (default 240). A node with an unusually
	 * complex body — e.g. the VST3 node's nested `stages` editor — can opt into
	 * a wider panel.
	 */
	readonly width?: number;
	[key: string]: unknown;
}

export interface SourceNodeData extends BaseNodeData {
	readonly category: "source";
	readonly ports: {
		readonly inputs: readonly [];
		readonly outputs: ReadonlyArray<PortDef>;
	};
}

export interface TransformNodeData extends BaseNodeData {
	readonly category: "transform";
	readonly ports: {
		readonly inputs: ReadonlyArray<PortDef>;
		readonly outputs: ReadonlyArray<PortDef>;
	};
}

export interface TargetNodeData extends BaseNodeData {
	readonly category: "target";
	readonly ports: {
		readonly inputs: ReadonlyArray<PortDef>;
		readonly outputs: readonly [];
	};
}

export type DemoNodeData = SourceNodeData | TransformNodeData | TargetNodeData;
