import type { Node, Edge } from "@xyflow/react";
import type { DemoNodeData } from "../components/graph/types";

/**
 * Sample graph that exercises every visual condition of the new node spec, using
 * the real node names and param shapes from `packages/buffered-audio-nodes/`.
 *
 * Conditions covered:
 *  - ≥2 sources: `Read` × 2 (one with a populated path, one with a blank path
 *    whose `path` param is flagged `complete: false`, surfacing the incomplete
 *    state as a coral param label)
 *  - ≥3 transforms: `Gain`, `DeepFilterNet3 (Denoiser)`, `Loudness Normalize`,
 *    `Normalize`
 *  - Terminal `Write` target
 *  - Mid-pipeline `Write` target (snapshot tap)
 *  - Bypassed node: `Normalize` (`bypassed: true`, `opacity-60`)
 *  - Incomplete-param node: the second `Read` (its `path` is blank and the
 *    param is flagged `complete: false`, so its label renders coral)
 *  - `file` and `objectArray` param shapes: the `VST3` transform node — its
 *    `stages` array, where each stage is a sub-form with `.vst3` / `.vstpreset`
 *    file paths
 *
 * Schema-derived param mappings (from `packages/buffered-audio-nodes/src/.../index.ts`):
 *  - `Read.path`   → `file`  (string, `meta.input: "file"`)
 *  - `Gain.gain`   → `knob`  (number, -60..24 dB, step 0.1, default 0)
 *  - `DeepFilterNet3.attenuation` → `knob` (number, 0..100 dB, default 30)
 *  - `Loudness Normalize.target`  → `knob` (number, -50..0 LUFS, step 0.1, default -16)
 *  - `Normalize.ceiling`          → `knob` (number, 0..1, step 0.01, default 1.0)
 *  - `Write.path`     → `file` (string, `meta.input: "file"`)
 *  - `Write.bitDepth` → `buttonSelection` (enum: "16" | "24" | "32" | "32f")
 *  - `VST3.stages`             → `objectArray` (`z.array` of stage objects, min 1)
 *  - `VST3` stage `pluginPath` → `file`   (`.vst3` plugin path)
 *  - `VST3` stage `pluginName` → `input`  (optional sub-plugin name, for shells)
 *  - `VST3` stage `presetPath` → `file`   (optional `.vstpreset` state file)
 *
 * Managed-binary path fields (`modelPath`, `ffmpegPath`, `onnxAddonPath`, VST3's
 * `vstHostPath`, etc.) and other non-graph-editor schema fields are intentionally
 * omitted — they are wired in the desktop app's environment-settings panel and
 * aren't editable on the node itself. The demo focuses on the graph-editor-
 * relevant params.
 */

const COL_GAP = 280;
const ROW_GAP = 220;

const col = (index: number) => index * COL_GAP;

const demoNodes: Array<Node<DemoNodeData>> = [
	{
		id: "read-1",
		type: "demoNode",
		position: { x: col(0), y: 0 },
		data: {
			name: "Read",
			category: "source",
			parameters: {
				path: {
					type: "file",
					value: "podcast-raw.wav",
					complete: true,
					mode: "open",
				},
			},
			ports: {
				inputs: [],
				outputs: [{ id: "out" }],
			},
			connectedOutputs: ["out"],
		},
	},
	{
		id: "read-2",
		type: "demoNode",
		position: { x: col(0), y: ROW_GAP },
		data: {
			name: "Read",
			category: "source",
			parameters: {
				path: { type: "file", value: "", complete: false, mode: "open" },
			},
			ports: {
				inputs: [],
				outputs: [{ id: "out" }],
			},
			connectedOutputs: ["out"],
		},
	},

	{
		id: "gain",
		type: "demoNode",
		position: { x: col(1), y: ROW_GAP / 2 },
		data: {
			name: "Gain",
			category: "transform",
			parameters: {
				gain: {
					type: "knob",
					value: -3,
					complete: true,
					min: -60,
					max: 24,
					step: 0.1,
					unit: "dB",
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [{ id: "out" }],
			},
			connectedInputs: ["in"],
			connectedOutputs: ["out"],
		},
	},
	{
		id: "deepfilter",
		type: "demoNode",
		position: { x: col(2), y: ROW_GAP / 2 },
		data: {
			name: "DeepFilterNet3 (Denoiser)",
			category: "transform",
			parameters: {
				attenuation: {
					type: "knob",
					value: 30,
					complete: true,
					min: 0,
					max: 100,
					step: 1,
					unit: "dB",
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [{ id: "out" }],
			},
			connectedInputs: ["in"],
			connectedOutputs: ["out"],
		},
	},
	{
		id: "loudness-normalize",
		type: "demoNode",
		position: { x: col(3), y: 0 },
		data: {
			name: "Loudness Normalize",
			category: "transform",
			parameters: {
				target: {
					type: "knob",
					value: -16,
					complete: true,
					min: -50,
					max: 0,
					step: 0.1,
					unit: "LUFS",
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [{ id: "out" }],
			},
			connectedInputs: ["in"],
			connectedOutputs: ["out"],
		},
	},
	{
		id: "normalize",
		type: "demoNode",
		position: { x: col(4), y: 0 },
		data: {
			name: "Normalize",
			category: "transform",
			bypassed: true,
			parameters: {
				ceiling: {
					type: "knob",
					value: 1,
					complete: true,
					min: 0,
					max: 1,
					step: 0.01,
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [{ id: "out" }],
			},
			connectedInputs: ["in"],
			connectedOutputs: ["out"],
		},
	},

	{
		id: "snapshot-tap",
		type: "demoNode",
		position: { x: col(3), y: ROW_GAP * 1.2 },
		data: {
			name: "Write",
			category: "target",
			parameters: {
				path: {
					type: "file",
					value: "after-denoise.wav",
					complete: true,
					mode: "save",
				},
				bitDepth: {
					type: "buttonSelection",
					value: "24",
					complete: true,
					options: ["16", "24", "32", "32f"],
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [],
			},
			connectedInputs: ["in"],
		},
	},

	{
		id: "vst3",
		type: "demoNode",
		position: { x: col(5), y: 0 },
		data: {
			name: "VST3",
			category: "transform",
			width: 300,
			parameters: {
				stages: {
					type: "objectArray",
					complete: true,
					itemNoun: "Stage",
					itemTemplate: {
						pluginPath: {
							type: "file",
							value: "",
							complete: false,
							accept: ".vst3",
							mode: "open",
						},
						pluginName: { type: "input", value: "", complete: true },
						presetPath: {
							type: "file",
							value: "",
							complete: true,
							accept: ".vstpreset",
							mode: "open",
						},
					},
					value: [
						{
							pluginPath: {
								type: "file",
								value:
									"C:/Program Files/Common Files/VST3/FabFilter Pro-Q 3.vst3",
								complete: true,
								accept: ".vst3",
								mode: "open",
							},
							pluginName: { type: "input", value: "", complete: true },
							presetPath: {
								type: "file",
								value: "presets/vocal-eq.vstpreset",
								complete: true,
								accept: ".vstpreset",
								mode: "open",
							},
						},
						{
							pluginPath: {
								type: "file",
								value:
									"C:/Program Files/Common Files/VST3/WaveShell1-VST3 14.0.vst3",
								complete: true,
								accept: ".vst3",
								mode: "open",
							},
							pluginName: {
								type: "input",
								value: "Renaissance Compressor",
								complete: true,
							},
							presetPath: {
								type: "file",
								value: "",
								complete: true,
								accept: ".vstpreset",
								mode: "open",
							},
						},
					],
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [{ id: "out" }],
			},
			connectedInputs: ["in"],
			connectedOutputs: ["out"],
		},
	},

	{
		id: "write-final",
		type: "demoNode",
		position: { x: col(7), y: 0 },
		data: {
			name: "Write",
			category: "target",
			parameters: {
				path: {
					type: "file",
					value: "podcast-clean.wav",
					complete: true,
					mode: "save",
				},
				bitDepth: {
					type: "buttonSelection",
					value: "24",
					complete: true,
					options: ["16", "24", "32", "32f"],
				},
			},
			ports: {
				inputs: [{ id: "in", required: true }],
				outputs: [],
			},
			connectedInputs: ["in"],
		},
	},
];

const demoEdges: Array<Edge> = [
	{
		id: "e-read1-gain",
		source: "read-1",
		target: "gain",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-read2-gain",
		source: "read-2",
		target: "gain",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-gain-deepfilter",
		source: "gain",
		target: "deepfilter",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-deepfilter-loudness",
		source: "deepfilter",
		target: "loudness-normalize",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-deepfilter-snapshot",
		source: "deepfilter",
		target: "snapshot-tap",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-loudness-normalize",
		source: "loudness-normalize",
		target: "normalize",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-normalize-vst3",
		source: "normalize",
		target: "vst3",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
	{
		id: "e-vst3-write",
		source: "vst3",
		target: "write-final",
		sourceHandle: "out",
		targetHandle: "in",
		type: "demoEdge",
	},
];

export { demoNodes, demoEdges };
export type { DemoNodeData };
