import type { GraphNode } from "@buffered-audio/core";
import { describe, expect, it } from "vitest";

import type { NodeJsonSchema, NodeJsonSchemaProperty } from "../../../../../../shared/ipc/Package/ensure/Renderer";
import { buildDefaultArrayItem, buildDefaultParameters, buildParameters } from "./buildParameters";

const buildNode = (parameters: Record<string, unknown>): GraphNode => ({
	id: "node-1",
	packageName: "pkg",
	packageVersion: "1.0.0",
	nodeName: "Node",
	parameters,
});

describe("buildParameters", () => {
	it("returns [] for a null schema and for a schema without properties", () => {
		expect(buildParameters(buildNode({}), null, {})).toEqual([]);
		expect(buildParameters(buildNode({}), {}, {})).toEqual([]);
	});

	describe("number leaf", () => {
		it("passes through a set value", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number", minimum: 0, maximum: 10 } } };
			const [param] = buildParameters(buildNode({ amount: 5 }), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.value).toBe(5);
		});

		it("seeds 0 when the unset range spans zero", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number", minimum: -10, maximum: 10 } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.value).toBe(0);
		});

		it("seeds the step-rounded midpoint for an unset negative-only range", () => {
			const schema: NodeJsonSchema = { properties: { targetTp: { type: "number", minimum: -60, maximum: -1 } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.value).toBe(-30.5);
		});

		it("shifts exclusiveMinimum/exclusiveMaximum inward by one step", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.min).toBe(0.01);
			expect(param.max).toBe(0.99);
		});

		it("defaults step to 1 for integer and 0.01 for number, overridden by multipleOf", () => {
			const schema: NodeJsonSchema = {
				properties: {
					count: { type: "integer" },
					amount: { type: "number" },
					snapped: { type: "integer", multipleOf: 5 },
				},
			};
			const [count, amount, snapped] = buildParameters(buildNode({}), schema, {});

			expect(count?.kind).toBe("number");
			expect(amount?.kind).toBe("number");
			expect(snapped?.kind).toBe("number");
			if (count?.kind !== "number" || amount?.kind !== "number" || snapped?.kind !== "number") return;

			expect(count.step).toBe(1);
			expect(amount.step).toBe(0.01);
			expect(snapped.step).toBe(5);
		});
	});

	it("boolean leaf: unset defaults to false", () => {
		const schema: NodeJsonSchema = { properties: { enabled: { type: "boolean" } } };
		const [param] = buildParameters(buildNode({}), schema, {});

		expect(param?.kind).toBe("boolean");
		if (param?.kind !== "boolean") return;

		expect(param.value).toBe(false);
	});

	describe("string leaf", () => {
		it("passes through a plain string value", () => {
			const schema: NodeJsonSchema = { properties: { label: { type: "string" } } };
			const [param] = buildParameters(buildNode({ label: "hello" }), schema, {});

			expect(param?.kind).toBe("string");
			if (param?.kind !== "string") return;

			expect(param.value).toBe("hello");
		});

		it("input: file yields kind file", () => {
			const schema: NodeJsonSchema = { properties: { path: { type: "string", input: "file" } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("file");
		});

		it("an unset binary value injects the matching binaryDefaults entry", () => {
			const schema: NodeJsonSchema = { properties: { path: { type: "string", input: "file", binary: "ffmpeg" } } };
			const [param] = buildParameters(buildNode({}), schema, { ffmpeg: "/usr/bin/ffmpeg" });

			expect(param?.kind).toBe("file");
			if (param?.kind !== "file") return;

			expect(param.value).toBe("/usr/bin/ffmpeg");
		});

		it("a set binary value is kept over the binaryDefaults entry", () => {
			const schema: NodeJsonSchema = { properties: { path: { type: "string", input: "file", binary: "ffmpeg" } } };
			const [param] = buildParameters(buildNode({ path: "/custom/ffmpeg" }), schema, { ffmpeg: "/usr/bin/ffmpeg" });

			expect(param?.kind).toBe("file");
			if (param?.kind !== "file") return;

			expect(param.value).toBe("/custom/ffmpeg");
		});
	});

	describe("enum leaf", () => {
		it("keeps a set string value", () => {
			const schema: NodeJsonSchema = { properties: { mode: { enum: ["a", "b"] } } };
			const [param] = buildParameters(buildNode({ mode: "b" }), schema, {});

			expect(param?.kind).toBe("enum");
			if (param?.kind !== "enum") return;

			expect(param.value).toBe("b");
		});

		it("falls back to enum[0] when unset, and exposes the schema enum as options", () => {
			const schema: NodeJsonSchema = { properties: { mode: { enum: ["a", "b"] } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("enum");
			if (param?.kind !== "enum") return;

			expect(param.value).toBe("a");
			expect(param.options).toEqual(["a", "b"]);
		});
	});

	describe("optional and defined", () => {
		it("a required property is optional: false, defined: true even when unset", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number" } }, required: ["amount"] };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.optional).toBe(false);
			expect(param.defined).toBe(true);
		});

		it("an optional unset property is defined: false", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number" } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.optional).toBe(true);
			expect(param.defined).toBe(false);
		});

		it("an optional set property is defined: true", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number" } } };
			const [param] = buildParameters(buildNode({ amount: 5 }), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.optional).toBe(true);
			expect(param.defined).toBe(true);
		});

		it("falls back to the schema default when unset", () => {
			const schema: NodeJsonSchema = { properties: { amount: { type: "number", default: 42 } } };
			const [param] = buildParameters(buildNode({}), schema, {});

			expect(param?.kind).toBe("number");
			if (param?.kind !== "number") return;

			expect(param.value).toBe(42);
		});
	});

	it("builds object children using the object's own required set, not the parent's", () => {
		const schema: NodeJsonSchema = {
			properties: {
				settings: {
					type: "object",
					required: ["threshold"],
					properties: { threshold: { type: "number", minimum: 0, maximum: 1 } },
				},
			},
		};

		const [withValue] = buildParameters(buildNode({ settings: { threshold: 0.5 } }), schema, {});

		expect(withValue?.kind).toBe("object");
		if (withValue?.kind !== "object") return;

		const [threshold] = withValue.children;

		expect(threshold?.kind).toBe("number");
		if (threshold?.kind !== "number") return;

		expect(threshold.value).toBe(0.5);
		expect(threshold.optional).toBe(false);
	});

	it("treats a non-object raw value as {}", () => {
		const schema: NodeJsonSchema = {
			properties: {
				settings: {
					type: "object",
					properties: { threshold: { type: "number", minimum: 0, maximum: 1 } },
				},
			},
		};

		const [withNonObject] = buildParameters(buildNode({ settings: "not-an-object" }), schema, {});

		expect(withNonObject?.kind).toBe("object");
		if (withNonObject?.kind !== "object") return;

		const [thresholdFallback] = withNonObject.children;

		expect(thresholdFallback?.kind).toBe("number");
		if (thresholdFallback?.kind !== "number") return;

		expect(thresholdFallback.optional).toBe(true);
		expect(thresholdFallback.defined).toBe(false);
	});

	it("builds array-of-object rows per element with unique rowIds; a non-array raw value yields zero rows", () => {
		const itemProperties: Record<string, NodeJsonSchemaProperty> = { label: { type: "string" } };
		const schema: NodeJsonSchema = {
			properties: { entries: { type: "array", items: { type: "object", properties: itemProperties } } },
		};

		const [withRows] = buildParameters(buildNode({ entries: [{ label: "a" }, { label: "b" }] }), schema, {});

		expect(withRows?.kind).toBe("array");
		if (withRows?.kind !== "array") return;

		expect(withRows.rows).toHaveLength(2);
		expect(withRows.rows[0]?.rowId).not.toBe(withRows.rows[1]?.rowId);
		expect(withRows.itemSchema).toBe(itemProperties);

		const [withNonArray] = buildParameters(buildNode({ entries: "not-an-array" }), schema, {});

		expect(withNonArray?.kind).toBe("array");
		if (withNonArray?.kind !== "array") return;

		expect(withNonArray.rows).toHaveLength(0);
	});

	it("omits unsupported shapes: array of scalars and object without properties", () => {
		const schema: NodeJsonSchema = {
			properties: {
				scalarArray: { type: "array", items: { type: "string" } },
				bareObject: { type: "object" },
				amount: { type: "number" },
			},
		};

		const result = buildParameters(buildNode({}), schema, {});

		expect(result.map((param) => param.name)).toEqual(["amount"]);
	});
});

describe("buildDefaultArrayItem", () => {
	it("maps each field to its default, or null when undeclared", () => {
		const itemProperties: Record<string, NodeJsonSchemaProperty> = { a: { default: "x" }, b: {} };

		expect(buildDefaultArrayItem(itemProperties)).toEqual({ a: "x", b: null });
	});
});

describe("buildDefaultParameters", () => {
	it("collects direct defaults", () => {
		const schema: NodeJsonSchema = { properties: { a: { default: 1 }, b: { default: "str" } } };

		expect(buildDefaultParameters(schema)).toEqual({ a: 1, b: "str" });
	});

	it("composes a record from an object's child defaults", () => {
		const schema: NodeJsonSchema = {
			properties: { settings: { type: "object", properties: { c: { default: 5 }, d: {} } } },
		};

		expect(buildDefaultParameters(schema)).toEqual({ settings: { c: 5 } });
	});

	it("leaves an object with no child defaults, and an array without a declared default, unset", () => {
		const schema: NodeJsonSchema = {
			properties: {
				settings: { type: "object", properties: { d: {} } },
				entries: { type: "array", items: { type: "object", properties: {} } },
			},
		};

		expect(buildDefaultParameters(schema)).toEqual({});
	});
});
