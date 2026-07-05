import type { Snapshot } from "valtio/vanilla";
import { Button } from "@buffered-audio/design-system";
import type { ModulePackageState } from "../models/State/App";

interface Props {
	readonly packages: Snapshot<Array<ModulePackageState>>;
	readonly isLoading: boolean;
	readonly onContinue: () => void;
}

function statusText(status: ModulePackageState["status"]): string {
	switch (status) {
		case "installing":
			return "Installing";
		case "loading":
			return "Loading";
		default:
			return "";
	}
}

export function LoadingScreen({ packages, isLoading, onContinue }: Props) {
	const hasError = packages.some((entry) => entry.status === "error");

	return (
		<div className="relative flex flex-1 flex-col overflow-hidden bg-surface p-6">
			<h1 className="type-display text-display-lg leading-none text-text-primary">
				BAGMAN
			</h1>

			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8">
				<ul className="flex flex-col gap-2">
					{packages.map((entry) => (
						<li key={entry.requestedSpec} className="flex flex-col gap-0.5">
							<div className="flex items-center gap-3">
								<span className="type-label text-body text-text-primary">
									{entry.name}
								</span>
								{entry.status === "pending" && (
									<span className="type-label text-dimmed">Pending</span>
								)}
								{(entry.status === "installing" || entry.status === "loading") && (
									<span className="type-label text-text-secondary">
										{statusText(entry.status)}
									</span>
								)}
								{entry.status === "ready" && (
									<span className="type-label text-text-secondary">Ready</span>
								)}
								{entry.status === "error" && (
									<span className="type-label text-accent-primary">Error</span>
								)}
							</div>
							{entry.status === "error" && entry.error && (
								<span className="text-body text-accent-primary">{entry.error}</span>
							)}
						</li>
					))}
				</ul>

				{!isLoading && (
					<Button variant="default" onClick={onContinue}>
						{hasError ? "Continue Anyway" : "Continue"}
					</Button>
				)}
			</div>
		</div>
	);
}
