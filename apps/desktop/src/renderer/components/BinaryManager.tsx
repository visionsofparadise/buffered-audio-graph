import { useCallback, useEffect, useState } from "react";
import { Button } from "@buffered-audio/design-system";
import type { AppContext } from "../models/Context";
import type { ModuleJsonSchema } from "../../shared/ipc/Package/loadModules/Renderer";

interface Props {
	readonly context: AppContext;
	readonly isOpen: boolean;
	readonly onClose: () => void;
}

interface BinaryInfo {
	name: string;
	currentPath: string | undefined;
}

function extractBinaries(context: AppContext): Array<BinaryInfo> {
	const binaryNames = new Set<string>();

	for (const entry of context.app.packages) {
		for (const mod of entry.modules) {
			const schema = mod.schema as ModuleJsonSchema | null;

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

export function BinaryManager({ context, isOpen, onClose }: Props) {
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

	const handleEscape = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		},
		[onClose],
	);

	useEffect(() => {
		if (!isOpen) return;

		document.addEventListener("keydown", handleEscape);

		return () => {
			document.removeEventListener("keydown", handleEscape);
		};
	}, [isOpen, handleEscape]);

	const handleOverlayClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (event.target === event.currentTarget) {
				onClose();
			}
		},
		[onClose],
	);

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

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
			onClick={handleOverlayClick}
		>
			<div className="bg-chrome-base w-[480px] max-h-[80vh] flex flex-col overflow-hidden">
				<div className="flex items-center justify-between px-4 py-3 border-b border-chrome-border">
					<h2 className="font-technical uppercase tracking-[0.06em] text-chrome-text text-md">
						Binary Manager
					</h2>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Close
					</Button>
				</div>

				<div className="flex-1 overflow-y-auto px-4 py-3">
					{binaries.length === 0 && (
						<p className="text-chrome-text-dim text-xs">
							No binary dependencies declared by installed modules.
						</p>
					)}

					<ul className="flex flex-col gap-2">
						{binaries.map((binary) => {
							const isBundled = binary.currentPath !== undefined && bundledPaths.has(binary.currentPath);

							return (
								<li key={binary.name} className="flex items-center gap-2">
									<span className="font-technical text-chrome-text text-sm w-32">
										{binary.name}
									</span>
									<span className="font-body text-sm flex-1 truncate flex items-center gap-2">
										{binary.currentPath ? (
											<>
												<span className="text-chrome-text-secondary truncate">{binary.currentPath}</span>
												{isBundled && (
													<span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.06em] text-chrome-text-dim bg-chrome-raised px-1.5 shrink-0">
														Bundled default
													</span>
												)}
											</>
										) : (
											<span className="text-chrome-text-dim">Not configured</span>
										)}
									</span>
									<Button
										variant="secondary"
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
			</div>
		</div>
	);
}
