import { describe, expect, it } from "vitest";
import { collectPackageEntryCandidates } from "./package-entry";

describe("collectPackageEntryCandidates", () => {
	it("prefers the subpath exports of the root entry over module and main", () => {
		const candidates = collectPackageEntryCandidates({
			exports: { ".": { import: "./dist/index.js", require: "./dist/index.cjs" } },
			module: "./dist/module.js",
			main: "./dist/main.cjs",
		});

		expect(candidates).toEqual(["./dist/index.js", "./dist/index.cjs", "./dist/module.js", "./dist/main.cjs"]);
	});

	it("orders conditional keys import, default, require, node ahead of the rest and drops types", () => {
		const candidates = collectPackageEntryCandidates({
			exports: { types: "./dist/index.d.ts", browser: "./dist/browser.js", require: "./r.cjs", import: "./i.js" },
		});

		expect(candidates).toEqual(["./i.js", "./r.cjs", "./dist/browser.js"]);
	});

	it("flattens a string, an array, and nested conditions", () => {
		expect(collectPackageEntryCandidates({ exports: "./flat.js" })).toEqual(["./flat.js"]);
		expect(collectPackageEntryCandidates({ exports: ["./a.js", "./b.js"] })).toEqual(["./a.js", "./b.js"]);
		expect(collectPackageEntryCandidates({ exports: { ".": { import: { default: "./deep.js" } } } })).toEqual([
			"./deep.js",
		]);
	});

	it("treats an exports field with no root subpath as the root entry itself", () => {
		expect(collectPackageEntryCandidates({ exports: { import: "./i.js" } })).toEqual(["./i.js"]);
	});

	it("drops private imports-field targets", () => {
		expect(collectPackageEntryCandidates({ exports: { ".": "#internal" }, main: "./main.js" })).toEqual([
			"./main.js",
		]);
	});

	it("falls back to module then main when there is no exports field", () => {
		expect(collectPackageEntryCandidates({ module: "./m.js", main: "./c.cjs" })).toEqual(["./m.js", "./c.cjs"]);
	});

	it("returns nothing for an empty or null manifest entry", () => {
		expect(collectPackageEntryCandidates({})).toEqual([]);
		expect(collectPackageEntryCandidates({ exports: null })).toEqual([]);
	});
});
