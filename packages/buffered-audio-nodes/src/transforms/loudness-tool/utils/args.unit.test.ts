import { describe, expect, it } from "vitest";
import { buildLoudnessToolArgs, validateLoudnessToolArgs } from "./args";

describe("buildLoudnessToolArgs", () => {
	it("puts --scratch-dir before the command, then raw stdin and WAV stdout after the args", () => {
		expect(
			buildLoudnessToolArgs(["target", "--lufs", "-16"], "/tmp/render", { sampleRate: 48000, channels: 2 }),
		).toEqual([
			"--scratch-dir",
			"/tmp/render",
			"target",
			"--lufs",
			"-16",
			"-f",
			"f32le",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-",
			"-f",
			"wav",
			"-o",
			"-",
		]);
	});
});

describe("validateLoudnessToolArgs", () => {
	it.each([
		["target", "--lufs", "-16", "--tp", "-1"],
		["tp-norm", "--tp", "-1"],
		["lufs-norm", "--lufs", "-23"],
		["crest", "--spread", "8", "--oversampling", "16"],
	])("accepts %s and its options", (...args) => {
		expect(validateLoudnessToolArgs(args)).toBeUndefined();
	});

	it.each([[[]], [["stats"]], [["--lufs", "-16"]], [["normalize"]]])("rejects %j as the command", (args) => {
		expect(validateLoudnessToolArgs(args)).toMatch(/^args must start with tp-norm, lufs-norm, target or crest/);
	});

	it.each([
		"-f",
		"-ar",
		"-ar:a",
		"-ac",
		"-ac:0",
		"-ch_layout",
		"-channel_layout:a",
		"-sample_rate",
		"-o",
		"-o-",
		"--output",
		"--output=x",
		"--scratch-dir",
		"--scratch-dir=/tmp",
		"pipe:",
		"pipe:0",
		"-",
		"--",
		"-h",
		"--help",
		"-V",
		"-V1",
		"-Vx",
		"-Vh",
		"-Vo",
		"--version",
	])("rejects %s, which the node owns", (token) => {
		expect(validateLoudnessToolArgs(["target", "--lufs", "-16", token])).toBe(
			`args must not contain "${token}", because the node owns loudness-tool's stdin, stdout, stream formats and scratch directory`,
		);
	});

	it.each([
		[["lufs-norm", "--lufs"], "--lufs"],
		[["tp-norm", "--tp"], "--tp"],
		[["crest", "--oversampling"], "--oversampling"],
		[["target", "--lufs", "--tp", "-1"], "--lufs"],
		[["target", "--tp", "-1", "--limit-db", "--never-expand"], "--limit-db"],
	])("rejects %j, whose %s has no value", (args, option) => {
		expect(validateLoudnessToolArgs(args)).toBe(`args must give "${option}" a value`);
	});

	it.each([
		["target", "--lufs", "-23", "--tp", "-1.5"],
		["target", "--lufs", "-16", "--floor", "-.5"],
		["target", "--tp", "-1", "--limit-db", "-3e0"],
	])("accepts negative numbers as values: %j", (...args) => {
		expect(validateLoudnessToolArgs(args)).toBeUndefined();
	});
});
