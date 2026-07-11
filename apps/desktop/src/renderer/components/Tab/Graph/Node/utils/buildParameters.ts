import type { GraphNode } from "@buffered-audio/core";
import type { NodeJsonSchema, NodeJsonSchemaProperty } from "../../../../../../shared/ipc/Package/loadNodes/Renderer";
import type { BooleanParameter } from "../ParameterRow/Boolean";
import type { EnumParameter } from "../ParameterRow/Enum";
import type { FileParameter } from "../ParameterRow/File";
import type { NumberParameter } from "../ParameterRow/Number";
import type { StringParameter } from "../ParameterRow/String";

/** A leaf scalar control — one of the five existing control kinds. */
export type LeafParameter = NumberParameter | BooleanParameter | EnumParameter | StringParameter | FileParameter;

/** An always-expanded object container whose children are further parameters. */
export interface ObjectParameter {
	readonly kind: "object";
	readonly name: string;
	readonly children: ReadonlyArray<Parameter>;
}

/** An array-of-object editor with Add/Delete/Reorder controls. */
export interface ArrayParameter {
	readonly kind: "array";
	readonly name: string;
	/** Schema for each object row — used when adding new rows. */
	readonly itemSchema: Readonly<Record<string, NodeJsonSchemaProperty>>;
	/** Current rows. Each row is a plain object with field name -> leaf parameter. */
	readonly rows: ReadonlyArray<ArrayRow>;
}

/** One row in an ArrayParameter editor. rowId is ephemeral and never persisted. */
export interface ArrayRow {
	/** UI-only identity — used as React key and for drag state. Never written to BAG. */
	readonly rowId: string;
	/** The fields of this row, ordered by schema. */
	readonly fields: ReadonlyArray<LeafParameter>;
}

export type Parameter = LeafParameter | ObjectParameter | ArrayParameter;

function buildLeafParameter(
	name: string,
	prop: NodeJsonSchemaProperty,
	currentValue: unknown,
	binaryDefaults: Record<string, string>,
): LeafParameter | null {
	if (prop.enum) {
		const enumValue = typeof currentValue === "string" ? currentValue : (prop.enum[0] ?? "");

		return {
			kind: "enum",
			name,
			value: enumValue,
			options: [...prop.enum],
		};
	}

	switch (prop.type) {
		case "number": {
			return {
				kind: "number",
				name,
				value: typeof currentValue === "number" ? currentValue : 0,
				min: prop.minimum ?? 0,
				max: prop.maximum ?? 1,
				step: prop.multipleOf ?? 0.01,
				unit: prop.description ?? "",
			};
		}

		case "boolean": {
			return {
				kind: "boolean",
				name,
				value: typeof currentValue === "boolean" ? currentValue : false,
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
				};
			}

			return {
				kind: "string",
				name,
				value: typeof currentValue === "string" ? currentValue : "",
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
): ReadonlyArray<Parameter> {
	const record = currentValue !== null && typeof currentValue === "object" && !Array.isArray(currentValue)
		? (currentValue as Record<string, unknown>)
		: {};
	const children: Array<Parameter> = [];

	for (const [fieldName, fieldProp] of Object.entries(properties)) {
		const fieldValue = record[fieldName] ?? fieldProp.default;
		const child = buildSingleParameter(fieldName, fieldProp, fieldValue, binaryDefaults);

		if (child !== null) children.push(child);
	}

	return children;
}

function buildArrayRow(
	itemProperties: Readonly<Record<string, NodeJsonSchemaProperty>>,
	rowValue: unknown,
	binaryDefaults: Record<string, string>,
): ArrayRow {
	const record = rowValue !== null && typeof rowValue === "object" && !Array.isArray(rowValue)
		? (rowValue as Record<string, unknown>)
		: {};
	const fields: Array<LeafParameter> = [];

	for (const [fieldName, fieldProp] of Object.entries(itemProperties)) {
		const fieldValue = record[fieldName] ?? fieldProp.default;
		const leaf = buildLeafParameter(fieldName, fieldProp, fieldValue, binaryDefaults);

		if (leaf !== null) fields.push(leaf);
	}

	return { rowId: crypto.randomUUID(), fields };
}

function buildSingleParameter(
	name: string,
	prop: NodeJsonSchemaProperty,
	currentValue: unknown,
	binaryDefaults: Record<string, string>,
): Parameter | null {
	if (prop.type === "object" && prop.properties) {
		return {
			kind: "object",
			name,
			children: buildObjectChildren(prop.properties, currentValue, binaryDefaults),
		};
	}

	if (prop.type === "array" && prop.items?.type === "object" && prop.items.properties) {
		const itemProperties = prop.items.properties;
		const rawArray = Array.isArray(currentValue) ? currentValue : [];
		const rows = rawArray.map((rowValue) => buildArrayRow(itemProperties, rowValue, binaryDefaults));

		return {
			kind: "array",
			name,
			itemSchema: itemProperties,
			rows,
		};
	}

	if (prop.type === "object" || prop.type === "array") {
		console.warn(`buildParameters: unsupported schema for "${name}" (type=${prop.type})`);

		return null;
	}

	return buildLeafParameter(name, prop, currentValue, binaryDefaults);
}

export function buildParameters(graphNode: GraphNode, nodeSchema: NodeJsonSchema | null, binaryDefaults: Record<string, string>): Array<Parameter> {
	if (!nodeSchema?.properties) return [];

	const parameters: Array<Parameter> = [];

	for (const [propertyName, prop] of Object.entries(nodeSchema.properties)) {
		const currentValue = graphNode.parameters?.[propertyName] ?? prop.default;
		const param = buildSingleParameter(propertyName, prop, currentValue, binaryDefaults);

		if (param !== null) parameters.push(param);
	}

	return parameters;
}

/** Build a default plain-JSON value for an array item from schema defaults. */
export function buildDefaultArrayItem(itemProperties: Readonly<Record<string, NodeJsonSchemaProperty>>): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const [fieldName, fieldProp] of Object.entries(itemProperties)) {
		result[fieldName] = fieldProp.default ?? null;
	}

	return result;
}

/**
 * Resolve a single property's schema default. A property contributes a default
 * when it declares one directly, or (for an object) when any of its children
 * do; otherwise it has none and is left unset. Object-array properties without
 * a declared default resolve to none — reset leaves them unset rather than
 * inventing empty rows.
 */
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

/**
 * Build the full default `parameters` record for a node from its schema —
 * every property set to its schema default, and left unset where the schema
 * declares none. Used by the bulk `resetNodeParameters` mutation.
 */
export function buildDefaultParameters(nodeSchema: NodeJsonSchema | null): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	if (!nodeSchema?.properties) return result;

	for (const [propertyName, prop] of Object.entries(nodeSchema.properties)) {
		const propertyDefault = defaultForProperty(prop);

		if (propertyDefault.has) result[propertyName] = propertyDefault.value;
	}

	return result;
}
