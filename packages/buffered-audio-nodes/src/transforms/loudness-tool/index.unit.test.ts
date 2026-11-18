import { describe, expect, it } from "vitest";
import { LoudnessToolNode } from ".";

describe("LoudnessToolNode schema", () => {
	it("defaults args to a valid lufs-norm command, so a fresh node parses", () => {
		expect(new LoudnessToolNode().properties.args).toEqual(["lufs-norm", "--lufs", "-23"]);
	});

	it.each([[[]], [["stats"]], [["lufs-norm", "-V1"]]])("still rejects an explicit %j", (args) => {
		expect(() => new LoudnessToolNode({ args })).toThrow('Invalid parameters for node "Loudness Tool"');
	});
});
