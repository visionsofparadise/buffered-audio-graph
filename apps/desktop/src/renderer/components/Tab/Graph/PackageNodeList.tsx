import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
} from "../../DropdownMenu";
import type { Snapshot } from "valtio/vanilla";
import type { AppState, NodePackageState } from "../../../models/State/App";

type ReadyPackage = Snapshot<NodePackageState> & {
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

export function PackageNodeList({ app, onSelect }: Props) {
	const latestReadyPackages = Array.from(
		app.packages
			.filter(
				(
					nodePackage,
				): nodePackage is ReadyPackage => nodePackage.status === "ready" && nodePackage.version !== null,
			)
			.reduce((packagesByName, nodePackage) => {
				const current = packagesByName.get(nodePackage.name);

				if (!current || compareVersions(nodePackage.version, current.version) > 0) {
					packagesByName.set(nodePackage.name, nodePackage);
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
			{latestReadyPackages.map((nodePackage) => (
				<DropdownMenuGroup key={nodePackage.name}>
					<DropdownMenuLabel>{nodePackage.name}</DropdownMenuLabel>
					{nodePackage.nodes.map((node) => (
						<DropdownMenuItem
							key={node.nodeName}
							className="flex-col items-start gap-0.5"
							onSelect={() => onSelect(nodePackage.name, nodePackage.version, node.nodeName)}
						>
							<span>{node.nodeName}</span>
							{node.description !== "" && (
								<span className="line-clamp-3 whitespace-normal text-xs normal-case leading-snug tracking-normal opacity-60">
									{node.description}
								</span>
							)}
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
			))}
		</>
	);
}
