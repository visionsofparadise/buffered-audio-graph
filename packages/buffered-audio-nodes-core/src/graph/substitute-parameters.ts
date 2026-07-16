import { traverse } from "radashi";
import type { GraphDefinition } from "./definition";

const placeholderPattern = /\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/g;

export function substituteParameters(definition: GraphDefinition, parameters: Record<string, string>): GraphDefinition {
	const usedNames = new Set<string>();
	const unboundNames = new Set<string>();

	const substitute = (value: string): string =>
		value.replace(placeholderPattern, (match, name: string) => {
			usedNames.add(name);

			const provided = Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : undefined;

			if (provided !== undefined) return provided;

			unboundNames.add(name);

			return match;
		});

	const nodes = definition.nodes.map((node) => {
		if (node.parameters === undefined) return node;

		const clonedParameters = structuredClone(node.parameters);

		traverse(clonedParameters, (value, key, parent) => {
			if (typeof value === "string") Reflect.set(parent, key, substitute(value));
		});

		return { ...node, parameters: clonedParameters };
	});

	const unknownNames = Object.keys(parameters).filter((name) => !usedNames.has(name));

	if (unboundNames.size > 0 || unknownNames.length > 0) {
		const messages: Array<string> = [];

		if (unboundNames.size > 0) messages.push(`unbound placeholders: ${[...unboundNames].join(", ")}`);
		if (unknownNames.length > 0) messages.push(`unknown parameters: ${unknownNames.join(", ")}`);

		throw new Error(`Parameter substitution failed — ${messages.join("; ")}`);
	}

	return { ...definition, nodes };
}
