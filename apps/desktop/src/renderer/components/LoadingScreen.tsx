import type { Snapshot } from "valtio/vanilla";
import { Button } from "@buffered-audio/design-system";
import type { ModulePackageState } from "../models/State/App";
import { EngineeringIcon } from "./EngineeringIcon";

interface Props {
	readonly packages: Snapshot<Array<ModulePackageState>>;
	readonly isLoading: boolean;
	readonly onContinue: () => void;
	readonly theme: "lava" | "viridis";
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

export function LoadingScreen({ packages, isLoading, onContinue, theme }: Props) {
	const hasError = packages.some((entry) => entry.status === "error");

	return (
		<div className="flex h-screen items-center justify-center bg-chrome-base">
			<div className="flex flex-col items-center gap-6">
				<div className="flex flex-col items-center gap-3">
					<EngineeringIcon theme={theme} className="h-16 w-16" title="Engineering" />
					<h1 className="font-body text-chrome-text text-xl">Engineering</h1>
				</div>

				<ul className="flex flex-col gap-2">
					{packages.map((entry) => (
						<li key={entry.requestedSpec} className="flex flex-col gap-0.5">
							<div className="flex items-center gap-3">
								<span className="font-technical uppercase tracking-[0.06em] text-chrome-text text-sm">
									{entry.name}
								</span>
								{entry.status === "pending" && (
									<span className="font-technical uppercase tracking-[0.06em] text-chrome-text-dim text-xs">
										Pending
									</span>
								)}
								{(entry.status === "installing" || entry.status === "loading") && (
									<span className="font-technical uppercase tracking-[0.06em] text-chrome-text-secondary text-xs">
										{statusText(entry.status)}
									</span>
								)}
								{entry.status === "ready" && (
									<span className="font-technical uppercase tracking-[0.06em] text-primary text-xs">
										Ready
									</span>
								)}
								{entry.status === "error" && (
									<span className="font-technical uppercase tracking-[0.06em] text-red-400 text-xs">
										Error
									</span>
								)}
							</div>
							{entry.status === "error" && entry.error && (
								<span className="text-xs text-red-400">{entry.error}</span>
							)}
						</li>
					))}
				</ul>

				{!isLoading && (
					<Button variant="primary" onClick={onContinue}>
						{hasError ? "Continue Anyway" : "Continue"}
					</Button>
				)}
			</div>
		</div>
	);
}
