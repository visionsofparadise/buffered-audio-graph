import { retrack } from "opshot/react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../UI/Button";
import type { AppContext } from "../../Models/Context";
import { extractBinaries } from "./utils/extractBinaries";

interface Props {
	readonly context: AppContext;
}

export const BinariesSection = retrack<Props>(({ context }: Props) => {
	const { app, main } = context;

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
				app.mutate((mutable) => {
					mutable.binaries[binaryName] = selectedPath;
				});
			}
		},
		[main, app],
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
