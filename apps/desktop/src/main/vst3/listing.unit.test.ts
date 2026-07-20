import { describe, expect, it } from "vitest";

import { CRASH_EXIT_CODES, isCrashExit, parseClassNames, tailLines } from "./listing";

describe("isCrashExit", () => {
	it("is true for both known crash exit codes", () => {
		for (const code of CRASH_EXIT_CODES) {
			expect(isCrashExit(code)).toBe(true);
		}
	});

	it("is false for 0, 1, and null", () => {
		expect(isCrashExit(0)).toBe(false);
		expect(isCrashExit(1)).toBe(false);
		expect(isCrashExit(null)).toBe(false);
	});
});

describe("parseClassNames", () => {
	it("parses a JSON string array", () => {
		expect(parseClassNames('["Synth", "Fx"]')).toEqual(["Synth", "Fx"]);
	});

	it("throws for non-JSON input", () => {
		expect(() => parseClassNames("not json")).toThrow();
	});

	it("throws for JSON of the wrong shape", () => {
		expect(() => parseClassNames("[1, 2]")).toThrow();
		expect(() => parseClassNames('{"a": 1}')).toThrow();
	});
});

describe("tailLines", () => {
	it("returns the last N lines across \\n and \\r\\n, trimmed", () => {
		expect(tailLines("a\nb\nc\nd\ne\nf", 3)).toBe("d\ne\nf");
		expect(tailLines("a\r\nb\r\nc\r\nd", 2)).toBe("c\nd");
		expect(tailLines("  \na\nb\n  ", 2)).toBe("a\nb");
	});

	it("returns all lines when the input is shorter than the count", () => {
		expect(tailLines("a\nb", 5)).toBe("a\nb");
	});

	it("defaults count to 5", () => {
		expect(tailLines("1\n2\n3\n4\n5\n6\n7")).toBe("3\n4\n5\n6\n7");
	});
});
