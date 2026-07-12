import { AsyncRendererIpc } from "../../../models/AsyncRendererIpc";

/** A single property from Zod v4's toJSONSchema() output. Meta fields from .meta() are flattened to the top level. */
export interface NodeJsonSchemaProperty {
	readonly type?: string;
	readonly enum?: ReadonlyArray<string>;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly multipleOf?: number;
	readonly default?: unknown;
	readonly description?: string;
	readonly input?: "file" | "folder";
	readonly mode?: "open" | "save";
	readonly binary?: string;
	/** For type === "object": child properties of the nested object. */
	readonly properties?: Readonly<Record<string, NodeJsonSchemaProperty>>;
	/** For type === "object": required child property names. */
	readonly required?: ReadonlyArray<string>;
	/** For type === "array": schema of each array item. Only array<object> is supported. */
	readonly items?: NodeJsonSchemaProperty;
}

/** The JSON Schema object produced by Zod v4's toJSONSchema() for a node's schema. */
export interface NodeJsonSchema {
	readonly type?: string;
	readonly properties?: Readonly<Record<string, NodeJsonSchemaProperty>>;
	readonly required?: ReadonlyArray<string>;
}

export interface LoadPackageNodesInput {
	readonly loadEntryPath: string;
	readonly packageName: string;
	readonly packageVersion: string;
}

export interface LoadedNodeInfo {
	readonly nodeName: string;
	readonly description: string;
	readonly schema: NodeJsonSchema;
	readonly category: "source" | "transform" | "target";
}

export interface LoadPackageNodesResult {
	readonly apiVersion: number;
	readonly nodes: ReadonlyArray<LoadedNodeInfo>;
}

export type LoadPackageNodesIpcParameters = [input: LoadPackageNodesInput];
export type LoadPackageNodesIpcReturn = LoadPackageNodesResult;
export const LOAD_PACKAGE_NODES_ACTION = "loadPackageNodes" as const;

export class LoadPackageNodesRendererIpc extends AsyncRendererIpc<
	typeof LOAD_PACKAGE_NODES_ACTION,
	LoadPackageNodesIpcParameters,
	LoadPackageNodesIpcReturn
> {
	action = LOAD_PACKAGE_NODES_ACTION;
}
