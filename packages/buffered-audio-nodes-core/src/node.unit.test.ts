import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Composition } from "./node";
import { SourceNode } from "./source";
import { TargetNode } from "./target";
import { TransformNode, type TransformNodeProperties } from "./transform";

class MockSource extends SourceNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "mock-source";
	static override readonly schema = z.object({});
}

interface MockTransformProperties extends TransformNodeProperties {
	readonly gain?: number;
}

class MockTransform extends TransformNode<MockTransformProperties> {
	static override readonly packageName = "test";
	static override readonly nodeName = "mock-transform";
	static override readonly schema = z.object({ gain: z.number().default(1) });
}

class MockTarget extends TargetNode {
	static override readonly packageName = "test";
	static override readonly nodeName = "mock-target";
	static override readonly schema = z.object({});
}

describe("BufferedAudioNode constructor parsing", () => {
	it("applies schema defaults", () => {
		const transform = new MockTransform();

		expect(transform.properties.gain).toBe(1);
	});

	it("preserves an explicit parameter over the default", () => {
		const transform = new MockTransform({ gain: 3 });

		expect(transform.properties.gain).toBe(3);
	});

	it("preserves base keys id/packageVersion/bypass/children through the parse merge", () => {
		const child = new MockTarget();
		const transform = new MockTransform({ id: "abc", packageVersion: "1.2.3", bypass: true, children: [child] });

		expect(transform.id).toBe("abc");
		expect(transform.packageVersion).toBe("1.2.3");
		expect(transform.isBypassed).toBe(true);
		expect(transform.children).toContain(child);
	});

	it("leaves packageVersion undefined when not provided", () => {
		const transform = new MockTransform();

		expect(transform.packageVersion).toBeUndefined();
	});

	it("throws naming the node when a parameter fails validation", () => {
		expect(() => new MockTransform({ gain: "loud" as unknown as number })).toThrow(/mock-transform/);
	});
});

describe("BufferedAudioNode.children getter", () => {
	it("returns raw children without bypass promotion", () => {
		const bypassedChild = new MockTransform({ bypass: true });
		const grandChild = new MockTarget();

		bypassedChild.to(grandChild);

		const source = new MockSource();
		source.to(bypassedChild);

		expect(source.children).toEqual([bypassedChild]);
	});
});

describe("SourceNode/TransformNode .to()", () => {
	it("appends a plain child", () => {
		const source = new MockSource();
		const target = new MockTarget();

		source.to(target);

		expect(source.children).toContain(target);
	});

	it("unwraps a Composition to its head", () => {
		const head = new MockTransform();
		const tail = new MockTarget();
		const composition: Composition = { head, tail };

		const source = new MockSource();
		source.to(composition);

		expect(source.children).toEqual([head]);
	});
});
