import { describe, expect, it } from "vitest";
import { pack } from "../../buffered-audio-nodes-core/src/graph-format";
import { read } from "./sources/read";
import { write } from "./targets/write";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./package-metadata";

describe("package metadata", () => {
	it("packs real buffered-audio-nodes classes with scoped package constants", () => {
		const source = read("input.wav");
		const target = write("output.wav");

		source.to(target);

		const definition = pack([source]);

		expect(definition.nodes).toHaveLength(2);
		expect(definition.nodes).toMatchObject([
			expect.objectContaining({
				packageName: PACKAGE_NAME,
				packageVersion: PACKAGE_VERSION,
				nodeName: "Read WAV",
			}),
			expect.objectContaining({
				packageName: PACKAGE_NAME,
				packageVersion: PACKAGE_VERSION,
				nodeName: "Write",
			}),
		]);
	});
});
