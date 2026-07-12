import { describe, expect, it } from "vitest";
import { parseParams, parseResolveOverrides } from "./parse-options";

describe("parseParams", () => {
	it("collects name=value entries, keeping the first '=' as the separator", () => {
		expect(parseParams(["a=1", "b=x=y"])).toEqual({ a: "1", b: "x=y" });
	});

	it("throws when an entry has no '='", () => {
		expect(() => parseParams(["a"])).toThrow(/name=value/);
	});

	it("throws on an empty name", () => {
		expect(() => parseParams(["=1"])).toThrow(/must not be empty/);
	});

	it("throws on a duplicate name", () => {
		expect(() => parseParams(["a=1", "a=2"])).toThrow(/given more than once/);
	});
});

describe("parseResolveOverrides", () => {
	it("collects name=path entries into a Map", () => {
		expect(parseResolveOverrides(["pkg=/abs/path"])).toEqual(new Map([["pkg", "/abs/path"]]));
	});

	it("throws when an entry has no '='", () => {
		expect(() => parseResolveOverrides(["pkg"])).toThrow(/name=path/);
	});

	it("throws on an empty name", () => {
		expect(() => parseResolveOverrides(["=/abs/path"])).toThrow(/name must not be empty/);
	});

	it("throws on an empty path", () => {
		expect(() => parseResolveOverrides(["pkg="])).toThrow(/path must not be empty/);
	});

	it("throws on a duplicate name", () => {
		expect(() => parseResolveOverrides(["pkg=/a", "pkg=/b"])).toThrow(/given more than once/);
	});
});
