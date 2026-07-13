import { describe, expect, it } from "vitest";
import { pack } from "@buffered-audio/core";
// eslint-disable-next-line import-x/extensions -- TypeScript JSON modules require the explicit specifier here.
import packageJson from "../package.json";
import { read } from "./sources/read";
import { write } from "./targets/write";

describe("pack resolves the nodes package version", () => {
	it("stamps @buffered-audio/nodes at its package.json version", () => {
		const source = read("input.wav");
		const target = write("output.wav");

		source.to(target);

		const definition = pack([source], { anchor: import.meta.url });

		expect(definition.nodes.every((node) => node.packageVersion === packageJson.version)).toBe(true);
	});
});
