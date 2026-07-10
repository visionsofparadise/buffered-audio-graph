import { pathToFileURL } from "node:url";
import { toJSONSchema } from "zod";
import { registerPackage, type NodeClass } from "../../../models/NodeRegistry";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { SUPPORTED_API_VERSIONS } from "../../../models/ApiVersion";
import { LOAD_PACKAGE_NODES_ACTION, type LoadPackageNodesInput, type LoadPackageNodesIpcParameters, type LoadPackageNodesIpcReturn, type LoadedNodeInfo } from "./Renderer";

function isNodeClass(value: unknown): value is NodeClass {
	return (
		typeof value === "function" && "nodeName" in value && typeof value.nodeName === "string" && "description" in value && typeof value.description === "string" && "schema" in value
	);
}

function getNodeCategory(value: NodeClass): "source" | "transform" | "target" {
	const prototype: unknown = value.prototype;

	if (typeof prototype === "object" && prototype !== null) {
		if ("createRenderJob" in prototype && typeof prototype.createRenderJob === "function") return "source";
		if ("to" in prototype && typeof prototype.to === "function") return "transform";
	}

	return "target";
}

export class LoadPackageNodesMainIpc extends AsyncMainIpc<LoadPackageNodesIpcParameters, LoadPackageNodesIpcReturn> {
	action = LOAD_PACKAGE_NODES_ACTION;

	async handler(input: LoadPackageNodesInput, dependencies: IpcHandlerDependencies): Promise<LoadPackageNodesIpcReturn> {
		const url = `${pathToFileURL(input.loadEntryPath).href}?t=${Date.now()}`;
		const exports = (await import(url)) as Record<string, unknown>;
		const nodes = new Map<string, NodeClass>();
		const result: Array<LoadedNodeInfo> = [];
		const apiVersions = new Set<number>();

		for (const value of Object.values(exports)) {
			if (isNodeClass(value)) {
				nodes.set(value.nodeName, value);
				apiVersions.add(value.apiVersion);

				result.push({
					nodeName: value.nodeName,
					description: value.description,
					schema: toJSONSchema(value.schema) as LoadedNodeInfo["schema"],
					category: getNodeCategory(value),
				});
			}
		}

		if (nodes.size === 0) {
			throw new Error(`Package "${input.packageName}" exports no node classes`);
		}

		if (apiVersions.size > 1) {
			throw new Error(`Package "${input.packageName}" has mixed API versions: ${[...apiVersions].join(", ")}`);
		}

		const [apiVersion] = apiVersions;

		if (apiVersion === undefined) {
			throw new Error(`Package "${input.packageName}" predates the apiVersion marker and cannot load`);
		}

		if (!SUPPORTED_API_VERSIONS.has(apiVersion)) {
			throw new Error(`Package "${input.packageName}" has unsupported API version ${apiVersion}`);
		}

		registerPackage(dependencies.nodeRegistry, input.packageName, input.packageVersion, nodes);

		return { apiVersion, nodes: result };
	}
}
