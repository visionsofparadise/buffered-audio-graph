import { Plus, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import type { AppContext } from "../models/Context";
import { resnapshot } from "../models/ProxyStore/resnapshot";
import { Button } from "./Button";

interface Props {
	readonly isOpen: boolean;
	readonly onClose: () => void;
	readonly context: AppContext;
}

export const Preferences = resnapshot<Props>(({ isOpen, onClose, context }: Props) => {
	const { app, appStore, main } = context;

	const scanRoots = app.vst3ScanRoots;

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

	const handleAddRoot = useCallback(async () => {
		const result = await main.showOpenDialog({
			title: "Select VST3 scan folder",
			properties: ["openDirectory"],
		});

		const selectedPath = result?.[0];

		if (!selectedPath) return;

		if (scanRoots.includes(selectedPath)) return;

		appStore.mutate(app, (proxy) => {
			if (proxy.vst3ScanRoots.includes(selectedPath)) return;

			proxy.vst3ScanRoots.push(selectedPath);
		});

		// Rescan against the next roots; open pickers refresh via vst3:scanUpdate.
		void main.vst3ScanPlugins([...scanRoots, selectedPath]);
	}, [main, appStore, app, scanRoots]);

	const handleRemoveRoot = useCallback(
		(root: string) => {
			const nextRoots = scanRoots.filter((entry) => entry !== root);

			appStore.mutate(app, (proxy) => {
				proxy.vst3ScanRoots = proxy.vst3ScanRoots.filter((entry) => entry !== root);
			});

			void main.vst3ScanPlugins([...nextRoots]);
		},
		[main, appStore, app, scanRoots],
	);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
			onClick={handleOverlayClick}
		>
			<div className="bg-elevated w-[480px] max-h-[80vh] flex flex-col overflow-hidden rounded-xs border border-border">
				<div className="flex items-center justify-between px-4 py-3 border-b border-border">
					<h2 className="type-label text-body text-text-primary">Preferences</h2>
					<Button
						variant="ghost"
						size="sm"
						onClick={onClose}
					>
						Close
					</Button>
				</div>

				<div className="flex-1 overflow-y-auto px-4 py-3">
					<div className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<h3 className="type-label text-text-secondary">VST3 scan roots</h3>
							<Button
								variant="outline"
								size="sm"
								icon={Plus}
								onClick={() => void handleAddRoot()}
							>
								Add folder
							</Button>
						</div>

						{scanRoots.length === 0 ? (
							<p className="text-dimmed text-xs">No scan roots configured. Add a folder to discover installed VST3 plugins.</p>
						) : (
							<ul className="flex flex-col gap-2">
								{scanRoots.map((root) => (
									<li
										key={root}
										className="flex items-center gap-2"
									>
										<span
											className="text-sm text-text-secondary flex-1 truncate"
											title={root}
										>
											{root}
										</span>
										<Button
											variant="ghost"
											size="sm"
											aria-label={`Remove ${root}`}
											onClick={() => handleRemoveRoot(root)}
										>
											<X
												size={14}
												strokeWidth={1.5}
												aria-hidden="true"
											/>
										</Button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>
		</div>
	);
});
