import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "@buffered-audio/design-system";
import type { AppContext } from "../models/Context";
import { resnapshot } from "../models/ProxyStore/resnapshot";
import { usePackageManager } from "../hooks/usePackageManager";

interface Props {
	readonly isOpen: boolean;
	readonly onClose: () => void;
	readonly context: AppContext;
}

export const PackageManager = resnapshot<Props>(({ isOpen, onClose, context }: Props) => {
	const { app } = context;
	const { addPackage, removePackage, updatePackage } = usePackageManager(context);

	const [packageSpec, setPackageSpec] = useState("");
	const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());

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

	const handleAdd = useCallback(async () => {
		if (!packageSpec.trim()) return;

		const requestedSpec = packageSpec.trim();

		setPackageSpec("");
		await addPackage(requestedSpec);
	}, [packageSpec, addPackage]);

	const toggleExpanded = useCallback((requestedSpec: string) => {
		setExpandedPackages((previous) => {
			const next = new Set(previous);

			if (next.has(requestedSpec)) {
				next.delete(requestedSpec);
			} else {
				next.add(requestedSpec);
			}

			return next;
		});
	}, []);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
			onClick={handleOverlayClick}
		>
			<div className="bg-elevated w-[640px] max-h-[80vh] flex flex-col overflow-hidden rounded-xs border border-border">
				<div className="flex items-center justify-between px-4 py-3 border-b border-border">
					<h2 className="type-label text-body text-text-primary">Package Manager</h2>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Close
					</Button>
				</div>

				<div className="flex-1 overflow-y-auto px-4 py-3">
					<ul className="flex flex-col gap-2">
						{app.packages.map((entry) => {
							const isExpanded = expandedPackages.has(entry.requestedSpec);

							return (
								<li key={entry.requestedSpec} className="bg-surface p-2 rounded-xs">
									<div className="flex items-center gap-2">
										{entry.nodes.length > 0 && (
											<button
												type="button"
												className="text-text-secondary hover:text-text-primary text-xs"
												onClick={() => toggleExpanded(entry.requestedSpec)}
											>
												{isExpanded ? "▼" : "▶"}
											</button>
										)}

										<span className="text-body text-text-primary flex-1">
											{entry.name}
										</span>

										{entry.version && (
											<span className="type-value text-xs text-text-secondary">
												{entry.version}
											</span>
										)}

										{entry.status === "ready" && (
											<span className="type-label text-xs text-text-secondary">
												Ready
											</span>
										)}
										{entry.status === "error" && (
											<span className="type-label text-xs text-accent-primary">
												Error
											</span>
										)}
										{entry.status !== "ready" && entry.status !== "error" && (
											<span className="type-label text-xs text-text-secondary">
												{entry.status}
											</span>
										)}

										<span className="type-value text-xs text-dimmed">
											{entry.nodes.length} nodes
										</span>

										<div className="flex items-center gap-1">
											<Button
												variant="outline"
												size="sm"
												onClick={() => void updatePackage(entry.requestedSpec)}
											>
												Update
											</Button>
											{!entry.isBuiltIn && (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => void removePackage(entry.requestedSpec)}
												>
													Remove
												</Button>
											)}
										</div>
									</div>

									<div className="mt-1 type-label text-xs text-dimmed">
										{entry.requestedSpec}
									</div>

									{entry.status === "error" && entry.error && (
										<div className="text-xs text-accent-primary mt-1">{entry.error}</div>
									)}

									{isExpanded && entry.nodes.length > 0 && (
										<ul className="mt-2 ml-4 flex flex-col gap-1">
											{entry.nodes.map((node) => (
												<li key={node.nodeName} className="flex flex-col">
													<span className="type-label text-xs text-text-primary">
														{node.nodeName}
													</span>
													{node.description && (
														<span className="text-xs text-text-secondary">
															{node.description}
														</span>
													)}
												</li>
											))}
										</ul>
									)}
								</li>
							);
						})}
					</ul>

					<div className="flex items-end gap-2 mt-3">
						<Input
							label="Package Spec"
							value={packageSpec}
							placeholder="@buffered-audio/nodes@latest"
							onChange={setPackageSpec}
							className="flex-1"
						/>
						<Button variant="default" onClick={() => void handleAdd()}>
							Add
						</Button>
					</div>

					<p className="text-dimmed text-xs mt-2">
						Packages run with full system access.
					</p>
				</div>
			</div>
		</div>
	);
});
