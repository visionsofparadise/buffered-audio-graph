import { retrack } from "opshot/react";
import { useCallback, useState } from "react";
import { Button } from "../Button";
import { Input } from "../Input";
import { Toggle } from "../Toggle";
import type { AppContext } from "../../models/Context";
import { usePackageManager } from "../../hooks/usePackageManager";

interface Props {
	readonly context: AppContext;
}

export const PackagesSection = retrack<Props>(({ context }: Props) => {
	const { app } = context;
	const { addPackage, removePackage, updatePackage, clearDependencies } = usePackageManager(context);

	const [packageSpec, setPackageSpec] = useState("");
	const [expandedPackages, setExpandedPackages] = useState<Set<string>>(new Set());

	const catalogPackages = app.packages.filter((entry) => entry.origin === "catalog");
	const dependencyCount = app.packages.filter((entry) => entry.origin === "dependency").length;

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

	const setInstallAutomatically = useCallback(
		(value: boolean) => {
			app.mutate((mutable) => {
				mutable.installBagPackagesAutomatically = value;
			});
		},
		[app],
	);

	return (
		<div className="flex flex-col">
			<div className="flex items-center justify-between gap-3 pb-4">
				<span className="text-body text-text-primary">Install bag packages automatically</span>
				<Toggle
					value={app.installBagPackagesAutomatically}
					label={app.installBagPackagesAutomatically ? "ON" : "OFF"}
					onChange={setInstallAutomatically}
				/>
			</div>

			<ul className="flex flex-col gap-2">
				{catalogPackages.map((entry) => {
					const isExpanded = expandedPackages.has(entry.requestedSpec);

					return (
						<li key={entry.requestedSpec} className="bg-surface p-3 rounded-xs">
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

			{dependencyCount > 0 && (
				<div className="flex items-center justify-between gap-3 mt-3">
					<span className="text-body text-text-secondary">
						{dependencyCount} bag {dependencyCount === 1 ? "dependency" : "dependencies"} cached
					</span>
					<Button variant="ghost" size="sm" onClick={() => void clearDependencies()}>
						Clear
					</Button>
				</div>
			)}

			<div className="flex items-center gap-2 mt-4">
				<Input
					value={packageSpec}
					placeholder="@buffered-audio/nodes@latest"
					onChange={setPackageSpec}
					className="flex-1"
				/>
				<Button variant="default" className="h-9" onClick={() => void handleAdd()}>
					Add
				</Button>
			</div>

			<p className="text-dimmed text-xs mt-2">
				Packages run with full system access.
			</p>
		</div>
	);
});
