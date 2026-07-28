import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToRows, type Row } from "./zod-rows";

describe("zodToRows", () => {
	it("renders a flat numeric schema (compressor pattern)", () => {
		const schema = z.object({
			threshold: z.number().min(-60).max(0).multipleOf(0.1).default(-24).describe("Threshold (dBFS)"),
			ratio: z.number().min(1).max(20).multipleOf(0.1).default(4).describe("Ratio"),
			attack: z.number().min(0).max(500).multipleOf(0.1).default(10).describe("Attack (ms)"),
		});

		const expected: Array<Row> = [
			{ name: "threshold", type: "number (-60 to 0, step 0.1)", default: "`-24`", description: "Threshold (dBFS)" },
			{ name: "ratio", type: "number (1 to 20, step 0.1)", default: "`4`", description: "Ratio" },
			{ name: "attack", type: "number (0 to 500, step 0.1)", default: "`10`", description: "Attack (ms)" },
		];

		expect(zodToRows(schema)).toEqual(expected);
	});

	it("renders enum fields with pipe-separated quoted options", () => {
		const schema = z.object({
			detection: z.enum(["peak", "rms"]).default("peak").describe("Detection mode"),
			stereoLink: z.enum(["average", "max", "none"]).default("average").describe("Stereo link"),
		});

		const expected: Array<Row> = [
			{ name: "detection", type: '"peak" \\| "rms"', default: '`"peak"`', description: "Detection mode" },
			{
				name: "stereoLink",
				type: '"average" \\| "max" \\| "none"',
				default: '`"average"`',
				description: "Stereo link",
			},
		];

		expect(zodToRows(schema)).toEqual(expected);
	});

	it("marks optional fields and renders missing defaults as em dash", () => {
		const schema = z.object({
			gain: z.number().min(-24).max(24).multipleOf(0.1).optional().describe("Gain (dB) — peaking and shelf only"),
			label: z.string().optional().describe("Display label"),
		});

		const expected: Array<Row> = [
			{
				name: "gain",
				type: "number (-24 to 24, step 0.1), optional",
				default: "—",
				description: "Gain (dB) — peaking and shelf only",
			},
			{ name: "label", type: "string, optional", default: "—", description: "Display label" },
		];

		expect(zodToRows(schema)).toEqual(expected);
	});

	it("flattens array-of-objects with `[]` path suffix (eq bands pattern)", () => {
		const bandSchema = z.object({
			type: z.enum(["lowpass", "peaking"]).default("peaking").describe("Filter type"),
			frequency: z.number().min(20).max(20000).multipleOf(1).default(1000).describe("Frequency (Hz)"),
			gain: z.number().min(-24).max(24).multipleOf(0.1).optional().describe("Gain (dB)"),
			enabled: z.boolean().default(true).describe("Enabled"),
		});
		const schema = z.object({
			bands: z.array(bandSchema).default([]).describe("EQ bands"),
		});

		const expected: Array<Row> = [
			{ name: "bands", type: "Object[]", default: "`[]`", description: "EQ bands" },
			{ name: "bands[].type", type: '"lowpass" \\| "peaking"', default: '`"peaking"`', description: "Filter type" },
			{
				name: "bands[].frequency",
				type: "number (20 to 20000, step 1)",
				default: "`1000`",
				description: "Frequency (Hz)",
			},
			{
				name: "bands[].gain",
				type: "number (-24 to 24, step 0.1), optional",
				default: "—",
				description: "Gain (dB)",
			},
			{ name: "bands[].enabled", type: "boolean", default: "`true`", description: "Enabled" },
		];

		expect(zodToRows(schema)).toEqual(expected);
	});

	it("appends download link when .meta({ download, binary }) is present", () => {
		const schema = z.object({
			modelPath1: z
				.string()
				.default("")
				.meta({
					input: "file",
					mode: "open",
					accept: ".onnx",
					binary: "dtln-model_1",
					download: "https://github.com/breizhn/DTLN",
				})
				.describe("DTLN magnitude mask model (.onnx)"),
			ffmpegPath: z
				.string()
				.default("")
				.meta({ input: "file", mode: "open", binary: "ffmpeg", download: "https://ffmpeg.org/download.html" })
				.describe("FFmpeg — audio/video processing tool"),
		});

		const expected: Array<Row> = [
			{
				name: "modelPath1",
				type: "string",
				default: '`""`',
				description: "DTLN magnitude mask model (.onnx) Download: [dtln-model_1](https://github.com/breizhn/DTLN)",
			},
			{
				name: "ffmpegPath",
				type: "string",
				default: '`""`',
				description: "FFmpeg — audio/video processing tool Download: [ffmpeg](https://ffmpeg.org/download.html)",
			},
		];

		expect(zodToRows(schema)).toEqual(expected);
	});

	it("renders unions of literals as pipe-separated literal labels (dither bitDepth pattern)", () => {
		const schema = z.object({
			bitDepth: z
				.union([z.literal(16), z.literal(24)])
				.default(16)
				.describe("Bit Depth"),
			oversampling: z
				.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)])
				.default(2)
				.describe("Oversampling"),
		});

		const expected: Array<Row> = [
			{ name: "bitDepth", type: "16 \\| 24", default: "`16`", description: "Bit Depth" },
			{ name: "oversampling", type: "1 \\| 2 \\| 4 \\| 8", default: "`2`", description: "Oversampling" },
		];

		expect(zodToRows(schema)).toEqual(expected);
	});

	it("renders min-only / max-only number constraints (normalize pattern with multipleOf)", () => {
		const schema = z.object({
			ceiling: z.number().min(0).max(1).multipleOf(0.01).default(1.0).describe("Ceiling"),
			onlyMin: z.number().min(0).default(0).describe("Only min"),
			onlyMax: z.number().max(10).default(10).describe("Only max"),
			onlyStep: z.number().multipleOf(0.5).default(0).describe("Only step"),
			unconstrained: z.number().default(0).describe("Unconstrained"),
		});

		const expected: Array<Row> = [
			{ name: "ceiling", type: "number (0 to 1, step 0.01)", default: "`1`", description: "Ceiling" },
			{ name: "onlyMin", type: "number (min 0)", default: "`0`", description: "Only min" },
			{ name: "onlyMax", type: "number (max 10)", default: "`10`", description: "Only max" },
			{ name: "onlyStep", type: "number (step 0.5)", default: "`0`", description: "Only step" },
			{ name: "unconstrained", type: "number", default: "`0`", description: "Unconstrained" },
		];

		expect(zodToRows(schema)).toEqual(expected);
	});
});
