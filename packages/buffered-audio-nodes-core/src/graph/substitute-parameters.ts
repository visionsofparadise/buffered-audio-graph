import { traverse } from "radashi";
import type { GraphDefinition } from "./definition";

const placeholderPattern = /\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/g;

function forEachPlaceholderName(parameters: Record<string, unknown>, onName: (name: string) => void): void {
	traverse(parameters, (value) => {
		if (typeof value !== "string") return;

		value.replace(placeholderPattern, (match, name: string) => {
			onName(name);

			return match;
		});
	});
}

export function collectParameters(definition: GraphDefinition): Array<string> {
	const names = new Set<string>();

	for (const node of definition.nodes) {
		if (node.parameters === undefined) continue;

		forEachPlaceholderName(node.parameters, (name) => names.add(name));
	}

	return [...names].sort();
}

export function substituteParameters(definition: GraphDefinition, parameters: Record<string, string>): GraphDefinition {
	const usedNames = new Set<string>();
	const unboundNames = new Set<string>();

	const nodes = definition.nodes.map((node) => {
		if (node.parameters === undefined) return node;

		const clonedParameters = structuredClone(node.parameters);

		forEachPlaceholderName(clonedParameters, (name) => {
			usedNames.add(name);

			const provided = Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : undefined;

			if (provided === undefined) unboundNames.add(name);
		});

		traverse(clonedParameters, (value, key, parent) => {
			if (typeof value !== "string") return;

			Reflect.set(
				parent,
				key,
				value.replace(placeholderPattern, (match, name: string) => {
					const provided = Object.prototype.hasOwnProperty.call(parameters, name) ? parameters[name] : undefined;

					return provided ?? match;
				}),
			);
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
