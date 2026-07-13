import { Command } from "cmdk";
import { useEffect, useRef } from "react";
import type { Snapshot } from "valtio/vanilla";
import type { AppState, NodePackageState } from "../../../models/State/App";
import type { NodeCategory } from "./Node/Container";

type ReadyPackage = Snapshot<NodePackageState> & {
	readonly status: "ready";
	readonly version: string;
};

const CATEGORY_ORDER: ReadonlyArray<{ readonly key: NodeCategory; readonly label: string }> = [
	{ key: "source", label: "Sources" },
	{ key: "transform", label: "Transforms" },
	{ key: "target", label: "Targets" },
];

function compareVersions(left: string, right: string): number {
	return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

const CATEGORY_HEADING_CLASS =
	"[&>[cmdk-group-heading]]:px-3 [&>[cmdk-group-heading]]:pb-1 [&>[cmdk-group-heading]]:pt-2 [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-[0.06em] [&>[cmdk-group-heading]]:text-text-secondary";

const PACKAGE_HEADING_CLASS =
	"[&>[cmdk-group-heading]]:px-3 [&>[cmdk-group-heading]]:pb-0.5 [&>[cmdk-group-heading]]:pt-1 [&>[cmdk-group-heading]]:text-[10px] [&>[cmdk-group-heading]]:tracking-[0.06em] [&>[cmdk-group-heading]]:text-dimmed";

interface Props {
	readonly app: Snapshot<AppState>;
	readonly onSelect: (packageName: string, nodeName: string) => void;
}

function NodeRow({
	packageName,
	nodeName,
	description,
	onSelect,
}: {
	readonly packageName: string;
	readonly nodeName: string;
	readonly description: string;
	readonly onSelect: (packageName: string, nodeName: string) => void;
}) {
	return (
		<Command.Item
			value={nodeName}
			keywords={[packageName]}
			onSelect={() => onSelect(packageName, nodeName)}
			className="flex cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-body text-text-primary outline-none data-[selected=true]:bg-text-primary data-[selected=true]:text-surface"
		>
			<span>{nodeName}</span>
			{description !== "" && (
				<span className="line-clamp-3 whitespace-normal text-xs normal-case leading-snug tracking-normal opacity-60">
					{description}
				</span>
			)}
		</Command.Item>
	);
}

export function PackageNodeList({ app, onSelect }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const raf = requestAnimationFrame(() => inputRef.current?.focus());

		return () => cancelAnimationFrame(raf);
	}, []);

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
		return <div className="type-label px-3 py-1.5 text-text-secondary">No packages loaded</div>;
	}

	const multiPackage = latestReadyPackages.length > 1;

	const categories = CATEGORY_ORDER.map(({ key, label }) => ({
		key,
		label,
		packages: latestReadyPackages
			.map((nodePackage) => ({
				nodePackage,
				nodes: nodePackage.nodes.filter((node) => node.category === key),
			}))
			.filter((entry) => entry.nodes.length > 0),
	})).filter((category) => category.packages.length > 0);

	return (
		<Command label="Node catalog" loop className="flex flex-col">
			<div className="px-2 pb-1 pt-2">
				<Command.Input
					ref={inputRef}
					autoFocus
					placeholder="Search nodes…"
					onKeyDown={(event) => {
						if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
							event.stopPropagation();
						}
					}}
					className="w-full rounded-xs bg-surface px-2.5 py-1.5 text-body text-text-primary outline-none placeholder:text-dimmed"
				/>
			</div>
			<Command.List className="max-h-[22rem] overflow-y-auto pb-1">
				<Command.Empty className="px-3 py-4 text-body text-dimmed">No nodes found</Command.Empty>
				{categories.map((category) => (
					<Command.Group key={category.key} heading={category.label} className={CATEGORY_HEADING_CLASS}>
						{multiPackage
							? category.packages.map(({ nodePackage, nodes }) => (
									<Command.Group
										key={nodePackage.name}
										heading={nodePackage.name}
										className={PACKAGE_HEADING_CLASS}
									>
										{nodes.map((node) => (
											<NodeRow
												key={node.nodeName}
												packageName={nodePackage.name}
												nodeName={node.nodeName}
												description={node.description}
												onSelect={onSelect}
											/>
										))}
									</Command.Group>
								))
							: category.packages.flatMap(({ nodePackage, nodes }) =>
									nodes.map((node) => (
										<NodeRow
											key={node.nodeName}
											packageName={nodePackage.name}
											nodeName={node.nodeName}
											description={node.description}
											onSelect={onSelect}
										/>
									)),
								)}
					</Command.Group>
				))}
			</Command.List>
		</Command>
	);
}
