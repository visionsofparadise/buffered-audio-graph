import { describe, expect, it } from "vitest";
import { CrestReduceNode, CrestReduceStream, schema } from ".";

describe("CrestReduce discoverability", () => {
	it("exposes the registration statics", () => {
		expect(CrestReduceNode.nodeName).toBe("Crest Reduce");
		expect(CrestReduceNode.Stream).toBe(CrestReduceStream);
	});

	it("the schema has NO `strength` field (removed by the 2026-05-17 keystone — the node always applies the optimal value)", () => {
		const parsed = schema.parse({});

		expect("strength" in parsed).toBe(false);
		expect(parsed.smoothing).toBe(100);
		expect(parsed.frameSize).toBe(2048);
	});
});
