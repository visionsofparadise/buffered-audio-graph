import { useCallback, useEffect, useState } from "react";
import { Button } from "../Button";
import type { NodeJsonSchema } from "../../../shared/ipc/Package/ensure/Renderer";
import type { AppContext } from "../../models/Context";
import { resnapshot } from "../../models/ProxyStore/resnapshot";

interface Props {
	readonly context: AppContext;
}

interface BinaryInfo {
	name: string;
	currentPath: string | undefined;
}

function extractBinaries(context: AppContext): Array<BinaryInfo> {
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

export const BinariesSection = resnapshot<Props>(({ context }: Props) => {
	const { app, appStore, main } = context;

	const binaries = extractBinaries(context);

	const [bundledPaths, setBundledPaths] = useState<ReadonlySet<string>>(() => new Set());

	useEffect(() => {
		let cancelled = false;

		void main.listBundledBinaries().then((bundled) => {
			if (cancelled) return;

			setBundledPaths(new Set(Object.values(bundled)));
		});

		return () => {
			cancelled = true;
		};
	}, [main]);

	const handleBrowse = useCallback(
		async (binaryName: string) => {
			const result = await main.showOpenDialog({
				title: `Select ${binaryName} binary`,
				properties: ["openFile"],
			});

			const selectedPath = result?.[0];

			if (selectedPath) {
				appStore.mutate(app, (proxy) => {
					proxy.binaries[binaryName] = selectedPath;
				});
			}
		},
		[main, appStore, app],
	);

	return (
		<div>
			{binaries.length === 0 && <p className="text-dimmed text-xs">No binary dependencies declared by installed nodes.</p>}

			<ul className="flex flex-col gap-2">
				{binaries.map((binary) => {
					const isBundled = binary.currentPath !== undefined && bundledPaths.has(binary.currentPath);

					return (
						<li
							key={binary.name}
							className="flex items-center gap-2"
						>
							<span className="type-label text-text-primary w-32">{binary.name}</span>
							<span className="text-sm flex-1 truncate flex items-center gap-2">
								{binary.currentPath ? (
									<>
										<span className="text-text-secondary truncate">{binary.currentPath}</span>
										{isBundled && <span className="type-label text-xs text-dimmed bg-surface px-1.5 shrink-0">Bundled default</span>}
									</>
								) : (
									<span className="text-dimmed">Not configured</span>
								)}
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => void handleBrowse(binary.name)}
							>
								Browse
							</Button>
						</li>
					);
				})}
			</ul>
		</div>
	);
});
