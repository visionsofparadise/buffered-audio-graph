import { pathToFileURL } from "node:url";
import { SourceNode, TargetNode, TransformNode } from "@buffered-audio/core";
import { toJSONSchema } from "zod";
import { registerPackage, type ModuleClass } from "../../../models/ModuleRegistry";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { LOAD_PACKAGE_MODULES_ACTION, type LoadPackageModulesInput, type LoadPackageModulesIpcParameters, type LoadPackageModulesIpcReturn, type LoadedModuleInfo } from "./Renderer";

function isAudioChainModule(value: unknown): value is ModuleClass {
	return (
		typeof value === "function" && "moduleName" in value && typeof value.moduleName === "string" && "moduleDescription" in value && typeof value.moduleDescription === "string" && "schema" in value
	);
}

function getModuleCategory(value: ModuleClass): "source" | "transform" | "target" {
	const instance = new value();

	if (SourceNode.is(instance)) return "source";
	if (TargetNode.is(instance)) return "target";
	if (TransformNode.is(instance)) return "transform";

	throw new Error(`Module "${value.moduleName}" does not extend SourceNode, TransformNode, or TargetNode`);
}

export class LoadPackageModulesMainIpc extends AsyncMainIpc<LoadPackageModulesIpcParameters, LoadPackageModulesIpcReturn> {
	action = LOAD_PACKAGE_MODULES_ACTION;

	async handler(input: LoadPackageModulesInput, dependencies: IpcHandlerDependencies): Promise<LoadPackageModulesIpcReturn> {
		const url = `${pathToFileURL(input.loadEntryPath).href}?t=${Date.now()}`;
		const exports = (await import(url)) as Record<string, unknown>;
		const modules = new Map<string, ModuleClass>();
		const result: Array<LoadedModuleInfo> = [];

		for (const value of Object.values(exports)) {
			if (isAudioChainModule(value)) {
				modules.set(value.moduleName, value);

				result.push({
					moduleName: value.moduleName,
					moduleDescription: value.moduleDescription,
					schema: toJSONSchema(value.schema) as LoadedModuleInfo["schema"],
					category: getModuleCategory(value),
				});
			}
		}

		registerPackage(dependencies.moduleRegistry, input.packageName, input.packageVersion, modules);

		return result;
	}
}
