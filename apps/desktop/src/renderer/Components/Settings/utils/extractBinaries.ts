import type { NodeJsonSchema } from "../../../../shared/ipc/Package/ensure/Renderer";
import type { AppContext } from "../../../Models/Context";

export interface BinaryInfo {
	name: string;
	currentPath: string | undefined;
}

export function extractBinaries(context: AppContext): Array<BinaryInfo> {
	const binaryNames = new Set<string>();

	for (const entry of context.app.packages) {
		for (const node of entry.nodes) {
			const schema = node.schema as NodeJsonSchema | null;

			if (!schema?.properties) continue;

			for (const prop of Object.values(schema.properties)) {
				if (prop.binary) {
					binaryNames.add(prop.binary);
				}
			}
		}
	}

	return Array.from(binaryNames)
		.sort()
		.map((name) => ({
			name,
			currentPath: (context.app.binaries as Record<string, string>)[name],
		}));
}
