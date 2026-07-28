import { AsyncRendererIpc } from "../../../Models/AsyncRendererIpc";

export interface NodeJsonSchemaProperty {
	readonly type?: string;
	readonly enum?: ReadonlyArray<string>;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly multipleOf?: number;
	readonly default?: unknown;
	readonly description?: string;
	readonly input?: "file" | "folder";
	readonly mode?: "open" | "save";
	readonly accept?: string;
	readonly binary?: string;
	readonly properties?: Readonly<Record<string, NodeJsonSchemaProperty>>;
	readonly required?: ReadonlyArray<string>;
	readonly items?: NodeJsonSchemaProperty;
}

export interface NodeJsonSchema {
	readonly type?: string;
	readonly properties?: Readonly<Record<string, NodeJsonSchemaProperty>>;
	readonly required?: ReadonlyArray<string>;
}

export interface LoadedNodeInfo {
	readonly nodeName: string;
	readonly description: string;
	readonly schema: NodeJsonSchema;
	readonly category: "source" | "transform" | "target";
}

export interface EnsurePackageInput {
	readonly packageSpec: string;
}

export interface EnsurePackageResult {
	readonly packageName: string;
	readonly packageVersion: string;
	readonly apiVersion: number;
	readonly nodes: ReadonlyArray<LoadedNodeInfo>;
}

export type EnsurePackageIpcParameters = [input: EnsurePackageInput];
export type EnsurePackageIpcReturn = EnsurePackageResult;
export const ENSURE_PACKAGE_ACTION = "ensurePackage" as const;

export class EnsurePackageRendererIpc extends AsyncRendererIpc<
	typeof ENSURE_PACKAGE_ACTION,
	EnsurePackageIpcParameters,
	EnsurePackageIpcReturn
> {
	action = ENSURE_PACKAGE_ACTION;
}
