import { useMemo, useState } from "react";
import { AppBar } from "./AppBar/AppBar";
import { LoadingScreen } from "./LoadingScreen";
import { Settings } from "./Settings";
import { Tab } from "./Tab";
import type { AppContext } from "../Models/Context";
import type { NodePackageState } from "../Models/State/App";
import type { Snapshot } from "opshot";

export type LayoutContextInput = Omit<AppContext, "setSettingsOpen">;

interface Props {
	readonly context: LayoutContextInput;
	readonly packages: Snapshot<Array<NodePackageState>>;
	readonly isLoadingPackages: boolean;
	readonly hasPassedLoading: boolean;
	readonly onContinueLoading: () => void;
}

export function Layout({
	context: baseContext,
	packages,
	isLoadingPackages,
	hasPassedLoading,
	onContinueLoading,
}: Props) {
	const [settingsOpen, setSettingsOpen] = useState(false);

	const context = useMemo(
		(): AppContext => ({
			...baseContext,
			setSettingsOpen,
		}),
		[baseContext],
	);

	return (
		<div className="flex flex-col h-screen">
			<AppBar context={context} chromeOnly={!hasPassedLoading} />
			{hasPassedLoading ? (
				<Tab context={context} />
			) : (
				<LoadingScreen packages={packages} isLoading={isLoadingPackages} onContinue={onContinueLoading} />
			)}
			<Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} context={context} />
		</div>
	);
}
