import { pack } from "@buffered-audio/core";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json";
import { read } from "./sources/read";
import { write } from "./targets/write";

describe("pack anchored in this package resolves this package's manifest", () => {
	it("stamps every node with the version from this package's package.json, not the workspace root's", () => {
		const source = read("input.wav");
		const target = write("output.wav");

		source.to(target);

		const definition = pack([source], { anchor: import.meta.url });

		expect(definition.nodes.every((node) => node.packageVersion === packageJson.version)).toBe(true);
	});
});
