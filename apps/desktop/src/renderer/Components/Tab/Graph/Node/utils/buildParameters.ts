import type { GraphNode } from "@buffered-audio/core";
import type { Logger } from "../../../../../../shared/Models/Logger";
import type { NodeJsonSchema, NodeJsonSchemaProperty } from "../../../../../../shared/ipc/Package/ensure/Renderer";
import type { BooleanParameter } from "../ParameterRow/Boolean";
import type { EnumParameter } from "../ParameterRow/Enum";
import type { FileParameter } from "../ParameterRow/File";
import type { NumberParameter } from "../ParameterRow/Number";
import type { StringParameter } from "../ParameterRow/String";

export type LeafParameter = NumberParameter | BooleanParameter | EnumParameter | StringParameter | FileParameter;

export interface ObjectParameter {
	readonly kind: "object";
	readonly name: string;
	readonly children: ReadonlyArray<Parameter>;
}

export interface ArrayParameter {
	readonly kind: "array";
	readonly name: string;
	readonly itemSchema: Readonly<Record<string, NodeJsonSchemaProperty>>;
	readonly rows: ReadonlyArray<ArrayRow>;
}

export interface ArrayRow {
	readonly rowId: string;
	readonly fields: ReadonlyArray<LeafParameter>;
}

export type Parameter = LeafParameter | ObjectParameter | ArrayParameter;

function buildLeafParameter(
	name: string,
	prop: NodeJsonSchemaProperty,
	rawValue: unknown,
	binaryDefaults: Record<string, string>,
	requiredSet: ReadonlySet<string>,
): LeafParameter | null {
	const optional = !requiredSet.has(name);
	const defined = !optional || rawValue !== undefined;
	const currentValue = rawValue ?? prop.default;

	if (prop.enum) {
		const enumValue = typeof currentValue === "string" ? currentValue : (prop.enum[0] ?? "");

		return {
			kind: "enum",
			name,
			value: enumValue,
			options: [...prop.enum],
			optional,
			defined,
		};
	}

	switch (prop.type) {
		case "number":
		case "integer": {
			const step = prop.multipleOf ?? (prop.type === "integer" ? 1 : 0.01);
			const min = prop.minimum ?? (prop.exclusiveMinimum !== undefined ? prop.exclusiveMinimum + step : 0);
			const max = prop.maximum ?? (prop.exclusiveMaximum !== undefined ? prop.exclusiveMaximum - step : 1);
			const seed = min <= 0 && 0 <= max ? 0 : Math.round((min + max) / 2 / step) * step;

			return {
				kind: "number",
				name,
				value: typeof currentValue === "number" ? currentValue : seed,
				min,
				max,
				step,
				description: prop.description ?? "",
				optional,
				defined,
			};
		}

		case "boolean": {
			return {
				kind: "boolean",
				name,
				value: typeof currentValue === "boolean" ? currentValue : false,
				optional,
				defined,
			};
		}

		case "string": {
			if (prop.input === "file" || prop.input === "folder") {
				let fileValue = typeof currentValue === "string" ? currentValue : "";

				if (prop.binary && !fileValue) {
					fileValue = binaryDefaults[prop.binary] ?? "";
				}

				return {
					kind: "file",
					name,
					value: fileValue,
					optional,
					defined,
					mode: prop.mode,
				};
			}

			return {
				kind: "string",
				name,
				value: typeof currentValue === "string" ? currentValue : "",
				optional,
				defined,
			};
		}

		default: {
			return null;
		}
	}
}

function buildObjectChildren(
	properties: Readonly<Record<string, NodeJsonSchemaProperty>>,
	currentValue: unknown,
	binaryDefaults: Record<string, string>,
	requiredSet: ReadonlySet<string>,
	logger?: Logger,
): ReadonlyArray<Parameter> {
	const record = currentValue !== null && typeof currentValue === "object" && !Array.isArray(currentValue)
		? (currentValue as Record<string, unknown>)
		: {};
	const children: Array<Parameter> = [];

	for (const [fieldName, fieldProp] of Object.entries(properties)) {
		const child = buildSingleParameter(fieldName, fieldProp, record[fieldName], binaryDefaults, requiredSet, logger);

		if (child !== null) children.push(child);
	}

	return children;
}

function buildArrayRow(
	itemProperties: Readonly<Record<string, NodeJsonSchemaProperty>>,
	rowValue: unknown,
	binaryDefaults: Record<string, string>,
	requiredSet: ReadonlySet<string>,
): ArrayRow {
	const record = rowValue !== null && typeof rowValue === "object" && !Array.isArray(rowValue)
		? (rowValue as Record<string, unknown>)
		: {};
	const fields: Array<LeafParameter> = [];

	for (const [fieldName, fieldProp] of Object.entries(itemProperties)) {
		const leaf = buildLeafParameter(fieldName, fieldProp, record[fieldName], binaryDefaults, requiredSet);

		if (leaf !== null) fields.push(leaf);
	}

	return { rowId: crypto.randomUUID(), fields };
}

function buildSingleParameter(
	name: string,
	prop: NodeJsonSchemaProperty,
	rawValue: unknown,
	binaryDefaults: Record<string, string>,
	requiredSet: ReadonlySet<string>,
	logger?: Logger,
): Parameter | null {
	if (prop.type === "object" && prop.properties) {
		const containerValue = rawValue ?? prop.default;

		return {
			kind: "object",
			name,
			children: buildObjectChildren(prop.properties, containerValue, binaryDefaults, new Set(prop.required ?? []), logger),
		};
	}

	if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
		const itemProperties = prop.items.properties;
		const itemRequiredSet = new Set(prop.items.required ?? []);
		const containerValue = rawValue ?? prop.default;
		const rawArray = Array.isArray(containerValue) ? containerValue : [];
		const rows = rawArray.map((rowValue) => buildArrayRow(itemProperties, rowValue, binaryDefaults, itemRequiredSet));

		return {
			kind: "array",
			name,
			itemSchema: itemProperties,
			rows,
		};
	}

	if (prop.type === "object" || prop.type === "array") {
		logger?.warn(`buildParameters: unsupported schema for "${name}" (type=${prop.type})`, { namespace: "graph" });

		return null;
	}

	return buildLeafParameter(name, prop, rawValue, binaryDefaults, requiredSet);
}

export function buildParameters(
	graphNode: GraphNode,
	nodeSchema: NodeJsonSchema | null,
	binaryDefaults: Record<string, string>,
	logger?: Logger,
): Array<Parameter> {
	if (!nodeSchema?.properties) return [];

	const requiredSet = new Set(nodeSchema.required ?? []);
	const parameters: Array<Parameter> = [];

	for (const [propertyName, prop] of Object.entries(nodeSchema.properties)) {
		const param = buildSingleParameter(propertyName, prop, graphNode.parameters?.[propertyName], binaryDefaults, requiredSet, logger);

		if (param !== null) parameters.push(param);
	}

	return parameters;
}

export function buildDefaultArrayItem(itemProperties: Readonly<Record<string, NodeJsonSchemaProperty>>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [fieldName, fieldProp] of Object.entries(itemProperties)) {
		result[fieldName] = fieldProp.default ?? null;
	}

	return result;
}

function defaultForProperty(prop: NodeJsonSchemaProperty): { has: boolean; value: unknown } {
	if (prop.default !== undefined) return { has: true, value: prop.default };

	if (prop.type === "object" && prop.properties) {
		const record: Record<string, unknown> = {};

		for (const [fieldName, fieldProp] of Object.entries(prop.properties)) {
			const childDefault = defaultForProperty(fieldProp);

			if (childDefault.has) record[fieldName] = childDefault.value;
		}

		if (Object.keys(record).length > 0) return { has: true, value: record };
	}

	return { has: false, value: undefined };
}

export function buildDefaultParameters(nodeSchema: NodeJsonSchema | null): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (!nodeSchema?.properties) return result;

	for (const [propertyName, prop] of Object.entries(nodeSchema.properties)) {
		const propertyDefault = defaultForProperty(prop);

		if (propertyDefault.has) result[propertyName] = propertyDefault.value;
	}

	return result;
}
