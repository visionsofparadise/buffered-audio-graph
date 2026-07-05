import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
} from "@buffered-audio/design-system";
import type { Snapshot } from "valtio/vanilla";
import type { AppState, ModulePackageState } from "../../../models/State/App";

type ReadyPackage = Snapshot<ModulePackageState> & {
	readonly status: "ready";
	readonly version: string;
};

function compareVersions(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

interface Props {
	readonly app: Snapshot<AppState>;
	readonly onSelect: (packageName: string, packageVersion: string, nodeName: string) => void;
}

export function PackageModuleList({ app, onSelect }: Props) {
	const latestReadyPackages = Array.from(
		app.packages
			.filter(
				(
					modulePackage,
				): modulePackage is ReadyPackage => modulePackage.status === "ready" && modulePackage.version !== null,
			)
			.reduce((packagesByName, modulePackage) => {
				const current = packagesByName.get(modulePackage.name);

				if (!current || compareVersions(modulePackage.version, current.version) > 0) {
					packagesByName.set(modulePackage.name, modulePackage);
				}

				return packagesByName;
			}, new Map<string, ReadyPackage>())
			.values(),
	);

	if (latestReadyPackages.length === 0) {
		return <DropdownMenuLabel>No packages loaded</DropdownMenuLabel>;
	}

	return (
		<>
			{latestReadyPackages.map((modulePackage) => (
				<DropdownMenuGroup key={modulePackage.name}>
					<DropdownMenuLabel>{modulePackage.name}</DropdownMenuLabel>
					{modulePackage.modules.map((mod) => (
						<DropdownMenuItem
							key={mod.moduleName}
							className="flex-col items-start gap-0.5"
							onSelect={() => onSelect(modulePackage.name, modulePackage.version, mod.moduleName)}
						>
							<span>{mod.moduleName}</span>
							{mod.moduleDescription !== "" && (
								<span className="line-clamp-3 whitespace-normal text-xs normal-case leading-snug tracking-normal opacity-60">
									{mod.moduleDescription}
								</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			))}
		</>
	);
}
