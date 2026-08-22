import { describe, expect, it } from "vitest";
import { resolveFaustDispatch } from "./dispatch";

describe("resolveFaustDispatch", () => {
	it("uses a single instance for mono through 1-in/1-out", () => {
		expect(resolveFaustDispatch(1, 1, 1)).toEqual({ mode: "single", outputChannels: 1 });
	});

	it("uses per-channel instances for stereo through 1-in/1-out", () => {
		expect(resolveFaustDispatch(1, 1, 2)).toEqual({ mode: "perChannel", outputChannels: 2 });
	});

	it("uses a single instance for stereo through 2-in/2-out", () => {
		expect(resolveFaustDispatch(2, 2, 2)).toEqual({ mode: "single", outputChannels: 2 });
	});

	it("widens mono through 1-in/2-out to two output channels", () => {
		expect(resolveFaustDispatch(1, 2, 1)).toEqual({ mode: "single", outputChannels: 2 });
	});

	it("throws for stereo through 1-in/2-out", () => {
		expect(() => resolveFaustDispatch(1, 2, 2)).toThrow(
			"Faust program has 1 inputs and 2 outputs; input has 2 channels",
		);
	});

	it("throws for a 0-input program", () => {
		expect(() => resolveFaustDispatch(0, 1, 1)).toThrow(
			"Faust program has 0 inputs and 1 outputs; input has 1 channels",
		);
	});

	it("throws for 3-channel input through 2-in/2-out", () => {
		expect(() => resolveFaustDispatch(2, 2, 3)).toThrow(
			"Faust program has 2 inputs and 2 outputs; input has 3 channels",
		);
	});
});
