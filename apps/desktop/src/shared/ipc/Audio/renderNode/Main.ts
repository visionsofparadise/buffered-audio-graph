import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserWindow } from "electron";
import type { ProgressPayload, SourceNode, StreamIdentity, TransformNode } from "@buffered-audio/core";
import { ReadWavNode, WriteNode } from "@buffered-audio/nodes";
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
	source: SourceNode,
	signal: AbortSignal,
	jobId: string,
	nodeId: string,
	renderedNodeName: string,
	browserWindow: BrowserWindow,
): Promise<void> {
	const job = source.createRenderJob({ signal });

	job.events.on("progress", (identity: StreamIdentity, payload: ProgressPayload): void => {
		if (identity.nodeName !== renderedNodeName) return;

		const progressPayload: AudioProgressPayload = {
			jobId,
			nodeId,
			phase: payload.phase,
			framesDone: payload.framesDone,
			framesTotal: payload.framesTotal,
		};

		browserWindow.webContents.send("audio:progress", progressPayload);
	});

	await job.render();
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

			await renderWithProgress(sourceInstance, signal, jobId, nodeId, SourceConstructor.nodeName, browserWindow);
		} else {
			if (!inputPath) {
				throw new Error(`No input path provided for transform node "${nodeId}"`);
			}

			const readInstance = new ReadWavNode({ path: inputPath });
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
