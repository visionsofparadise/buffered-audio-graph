import { pathToFileURL } from "node:url";
import { SourceNode, TargetNode, TransformNode } from "@buffered-audio/core";
import { toJSONSchema } from "zod";
import { registerPackage, type NodeClass } from "../../../models/NodeRegistry";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { LOAD_PACKAGE_NODES_ACTION, type LoadPackageNodesInput, type LoadPackageNodesIpcParameters, type LoadPackageNodesIpcReturn, type LoadedNodeInfo } from "./Renderer";

function isNodeClass(value: unknown): value is NodeClass {
	return (
		typeof value === "function" && "nodeName" in value && typeof value.nodeName === "string" && "nodeDescription" in value && typeof value.nodeDescription === "string" && "schema" in value
	);
}

function getNodeCategory(value: NodeClass): "source" | "transform" | "target" {
	const instance = new value();

	if (SourceNode.is(instance)) return "source";
	if (TargetNode.is(instance)) return "target";
	if (TransformNode.is(instance)) return "transform";

	throw new Error(`Node class "${value.nodeName}" does not extend SourceNode, TransformNode, or TargetNode`);
}

export class LoadPackageNodesMainIpc extends AsyncMainIpc<LoadPackageNodesIpcParameters, LoadPackageNodesIpcReturn> {
	action = LOAD_PACKAGE_NODES_ACTION;

	async handler(input: LoadPackageNodesInput, dependencies: IpcHandlerDependencies): Promise<LoadPackageNodesIpcReturn> {
		const url = `${pathToFileURL(input.loadEntryPath).href}?t=${Date.now()}`;
		const exports = (await import(url)) as Record<string, unknown>;
		const nodes = new Map<string, NodeClass>();
		const result: Array<LoadedNodeInfo> = [];

		for (const value of Object.values(exports)) {
			if (isNodeClass(value)) {
				nodes.set(value.nodeName, value);

				result.push({
					nodeName: value.nodeName,
					nodeDescription: value.nodeDescription,
					schema: toJSONSchema(value.schema) as LoadedNodeInfo["schema"],
					category: getNodeCategory(value),
				});
			}
		}

		registerPackage(dependencies.nodeRegistry, input.packageName, input.packageVersion, nodes);

		return result;
	}
}
