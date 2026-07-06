import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BufferedAudioNode, type Composition } from "./node";
import { SourceNode } from "./source";
import { TargetNode } from "./target";
import { TransformNode } from "./transform";

class MockSource extends SourceNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-source";
	static override readonly schema = z.object({});

	readonly type = ["buffered-audio-node", "source", "mock"] as const;

	clone(): MockSource {
		return new MockSource();
	}
}

class MockTransform extends TransformNode<{ gain?: number } & Record<string, unknown>> {
	static readonly packageName = "test";
	static readonly nodeName = "mock-transform";
	static override readonly schema = z.object({ gain: z.number().default(1) });

	readonly type = ["buffered-audio-node", "transform", "mock"] as const;

	clone(): MockTransform {
		return new MockTransform();
	}
}

class MockTarget extends TargetNode {
	static readonly packageName = "test";
	static readonly nodeName = "mock-target";
	static override readonly schema = z.object({});

	readonly type = ["buffered-audio-node", "target", "mock"] as const;

	clone(): MockTarget {
		return new MockTarget();
	}
}

describe("BufferedAudioNode type discrimination", () => {
	it("is() distinguishes node kinds", () => {
		const source = new MockSource();
		const transform = new MockTransform();
		const target = new MockTarget();

		expect(BufferedAudioNode.is(source)).toBe(true);
		expect(BufferedAudioNode.is({})).toBe(false);
		expect(BufferedAudioNode.is(null)).toBe(false);

		expect(SourceNode.is(source)).toBe(true);
		expect(SourceNode.is(transform)).toBe(false);
		expect(TransformNode.is(transform)).toBe(true);
		expect(TargetNode.is(target)).toBe(true);
		expect(TargetNode.is(source)).toBe(false);
	});
});

describe("BufferedAudioNode constructor parsing", () => {
	it("applies schema defaults", () => {
		const transform = new MockTransform();

		expect(transform.properties.gain).toBe(1);
	});

	it("preserves an explicit parameter over the default", () => {
		const transform = new MockTransform({ gain: 3 });

		expect(transform.properties.gain).toBe(3);
	});

	it("preserves base keys id/bypass/children through the parse merge", () => {
		const child = new MockTarget();
		const transform = new MockTransform({ id: "abc", bypass: true, children: [child] });

		expect(transform.id).toBe("abc");
		expect(transform.isBypassed).toBe(true);
		expect(transform.children).toContain(child);
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
