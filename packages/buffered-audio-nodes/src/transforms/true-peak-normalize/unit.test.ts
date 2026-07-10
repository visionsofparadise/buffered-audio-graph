import { describe, expect, it } from "vitest";
import { schema, truePeakNormalize } from ".";

describe("truePeakNormalize - schema", () => {
	it("parses an empty options object using the default target -1 dBTP", () => {
		const parsed = schema.parse({});

		expect(parsed.target).toBe(-1);
	});

	it("rejects target = 0 (lt(0) constraint)", () => {
		expect(() => schema.parse({ target: 0 })).toThrow();
	});

	it("rejects positive target", () => {
		expect(() => schema.parse({ target: 0.5 })).toThrow();
	});

	it("accepts negative target overrides", () => {
		expect(schema.parse({ target: -3 }).target).toBe(-3);
		expect(schema.parse({ target: -0.1 }).target).toBe(-0.1);
	});

	it("factory function builds a node with the parsed default", () => {
		const node = truePeakNormalize();

		expect(node.properties.target).toBe(-1);
	});
});
