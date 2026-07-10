import { describe, expect, it } from "vitest";
import { ReadWavNode, readWav } from ".";

describe("ReadWavNode", () => {
	it("creates a ReadWavNode via readWav convenience function", () => {
		const node = readWav("test.wav");

		expect(node).toBeInstanceOf(ReadWavNode);
	});

	it("creates a ReadWavNode with channel selection", () => {
		const node = readWav("test.wav", { channels: [0] });

		expect(node).toBeInstanceOf(ReadWavNode);
	});
});
