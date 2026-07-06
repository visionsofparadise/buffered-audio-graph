import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserWindow } from "electron";
import type { NodeIdentity, SourceNode, StreamEvent, TransformNode } from "@buffered-audio/core";
import { ReadNode, WriteNode } from "@buffered-audio/nodes";
import { AsyncMainIpc, type IpcHandlerDependencies } from "../../../models/AsyncMainIpc";
import { resolvePackageNodes, type NodeClass, type NodeRegistryMap } from "../../../models/NodeRegistry";
import type { AudioProgressPayload } from "../../../utilities/emitToRenderer";
import { RENDER_NODE_ACTION, type RenderNodeInput, type RenderNodeIpcParameters, type RenderNodeIpcReturn } from "./Renderer";

function resolveNode(registry: NodeRegistryMap, packageName: string, packageVersion: string, nodeName: string): NodeClass {
	const packageNodes = resolvePackageNodes(registry, packageName, packageVersion);

	if (!packageNodes) {
		throw new Error(`Package "${packageName}@${packageVersion}" not found in node registry`);
	}

	const NodeConstructor = packageNodes.get(nodeName);

	if (!NodeConstructor) {
		throw new Error(`Node "${nodeName}" not found in package "${packageName}@${packageVersion}"`);
	}

	return NodeConstructor;
}

async function renderWithProgress(
	sourceNode: ReadNode,
	signal: AbortSignal,
	jobId: string,
	nodeId: string,
	renderedNodeName: string,
	browserWindow: BrowserWindow,
): Promise<void> {
	const onEvent = (identity: NodeIdentity, event: StreamEvent): void => {
		if (event.kind !== "progress") return;
		if (identity.nodeName !== renderedNodeName) return;

		const payload: AudioProgressPayload = {
			jobId,
			nodeId,
			phase: event.phase,
			framesDone: event.framesDone,
			framesTotal: event.framesTotal,
		};

		browserWindow.webContents.send("audio:progress", payload);
	};

	await sourceNode.render({ signal, onEvent });
}

export class RenderNodeMainIpc extends AsyncMainIpc<RenderNodeIpcParameters, RenderNodeIpcReturn> {
	action = RENDER_NODE_ACTION;

	async handler(input: RenderNodeInput, dependencies: IpcHandlerDependencies): Promise<RenderNodeIpcReturn> {
		const { browserWindow, jobManager, nodeRegistry } = dependencies;
		const {
			jobId,
			nodeId,
			packageName,
			packageVersion,
			nodeName,
			parameters,
			isSourceNode,
			inputPath,
			outputPath,
		} = input;

		const signal = jobManager.getOrCreateSignal(jobId);

		if (signal.aborted) return undefined;

		await mkdir(dirname(outputPath), { recursive: true });

		if (isSourceNode) {
			const SourceConstructor = resolveNode(nodeRegistry, packageName, packageVersion, nodeName);
			const sourceInstance = new SourceConstructor(parameters) as SourceNode;
			const writeInstance = new WriteNode({ path: outputPath, bitDepth: "32f" });

			sourceInstance.to(writeInstance);

			await renderWithProgress(sourceInstance as ReadNode, signal, jobId, nodeId, SourceConstructor.nodeName, browserWindow);
		} else {
			if (!inputPath) {
				throw new Error(`No input path provided for transform node "${nodeId}"`);
			}

			const readInstance = new ReadNode({ path: inputPath, ffmpegPath: "", ffprobePath: "" });
			const TransformConstructor = resolveNode(nodeRegistry, packageName, packageVersion, nodeName);
			const transformInstance = new TransformConstructor(parameters) as TransformNode;
			const writeInstance = new WriteNode({ path: outputPath, bitDepth: "32f" });

			readInstance.to(transformInstance);
			transformInstance.to(writeInstance);

			await renderWithProgress(readInstance, signal, jobId, nodeId, TransformConstructor.nodeName, browserWindow);
		}

		return undefined;
	}
}
