import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "valtio/vanilla";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "../../DropdownMenu";
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

interface CatalogNode {
	readonly packageName: string;
	readonly nodeName: string;
	readonly description: string;
}

interface CategoryGroup {
	readonly key: NodeCategory;
	readonly label: string;
	readonly packages: ReadonlyArray<{ readonly packageName: string; readonly nodes: ReadonlyArray<CatalogNode> }>;
	readonly total: number;
}

interface Props {
	readonly app: Snapshot<AppState>;
	readonly onSelect: (packageName: string, nodeName: string) => void;
}

/** A node row — a Radix menu item, so both mouse and Radix's own keyboard nav select it. */
function NodeItem({ node, onSelect }: { readonly node: CatalogNode; readonly onSelect: Props["onSelect"] }) {
	return (
		<DropdownMenuItem
			data-catalog-item={node.nodeName}
			onSelect={() => onSelect(node.packageName, node.nodeName)}
			className="flex-col items-start gap-0.5"
		>
			<span className="text-body normal-case tracking-normal">{node.nodeName}</span>
			{node.description !== "" && (
				<span className="line-clamp-3 whitespace-normal text-xs normal-case leading-snug tracking-normal opacity-70">
					{node.description}
				</span>
			)}
		</DropdownMenuItem>
	);
}

export function PackageNodeList({ app, onSelect }: Props) {
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");

	// Radix focuses the first menu item when the menu opens, and does so in an
	// effect whose timing races a one-shot focus() here. Reclaim focus on a short
	// interval so that however Radix's focus settles, the next tick returns it to
	// the search field before any typing — deterministic where a single rAF was
	// flaky. Safe because the category submenus open on hover, not on focus, so a
	// reclaim never blocks browsing. The window is brief; after it, focus is left
	// wherever the user put it.
	useEffect(() => {
		const input = inputRef.current;

		if (!input) return;

		input.focus();

		let elapsed = 0;
		const id = setInterval(() => {
			elapsed += 40;

			if (document.activeElement !== input) input.focus();

			if (elapsed >= 280) clearInterval(id);
		}, 40);

		return () => clearInterval(id);
	}, []);

	const latestReadyPackages = useMemo(
		() =>
			Array.from(
				app.packages
					.filter(
						(nodePackage): nodePackage is ReadyPackage =>
							nodePackage.status === "ready" && nodePackage.version !== null,
					)
					.reduce((packagesByName, nodePackage) => {
						const current = packagesByName.get(nodePackage.name);

						if (!current || compareVersions(nodePackage.version, current.version) > 0) {
							packagesByName.set(nodePackage.name, nodePackage);
						}

						return packagesByName;
					}, new Map<string, ReadyPackage>())
					.values(),
			),
		[app.packages],
	);

	const normalizedQuery = query.trim().toLowerCase();
	const multiPackage = latestReadyPackages.length > 1;

	const categories = useMemo<ReadonlyArray<CategoryGroup>>(() => {
		const matches = (nodeName: string): boolean =>
			normalizedQuery === "" || nodeName.toLowerCase().includes(normalizedQuery);

		return CATEGORY_ORDER.map(({ key, label }) => {
			const packages = latestReadyPackages
				.map((nodePackage) => ({
					packageName: nodePackage.name,
					nodes: nodePackage.nodes
						.filter((node) => node.category === key && matches(node.nodeName))
						.map((node) => ({ packageName: nodePackage.name, nodeName: node.nodeName, description: node.description })),
				}))
				.filter((entry) => entry.nodes.length > 0);

			return { key, label, packages, total: packages.reduce((sum, entry) => sum + entry.nodes.length, 0) };
		}).filter((category) => category.total > 0);
	}, [latestReadyPackages, normalizedQuery]);

	// Flat, ordered matches — the target for a type-then-Enter (no arrow) pick.
	const searchFlat = useMemo<ReadonlyArray<CatalogNode>>(
		() => (normalizedQuery === "" ? [] : categories.flatMap((category) => category.packages.flatMap((entry) => entry.nodes))),
		[normalizedQuery, categories],
	);

	const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
		const searchingNow = normalizedQuery !== "";

		if (searchingNow && event.key === "ArrowDown") {
			// Bridge focus from the input into the Radix item list; roving nav takes
			// over from there. (Radix's own arrow handling does not move focus off a
			// non-item like the search field.)
			event.preventDefault();
			listRef.current?.querySelector<HTMLElement>("[data-catalog-item]")?.focus();
		} else if (searchingNow && event.key === "Enter") {
			// Type-and-Enter with no arrowing picks the first match.
			event.preventDefault();
			event.stopPropagation();

			const node = searchFlat[0];

			if (node) onSelect(node.packageName, node.nodeName);
		} else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			// Keep printable keys in the field — Radix menu typeahead would otherwise
			// steal them to move roving focus onto an item.
			event.stopPropagation();
		}
	};

	if (latestReadyPackages.length === 0) {
		return <div className="type-label px-4 py-2 text-text-secondary">No packages loaded</div>;
	}

	const searching = normalizedQuery !== "";

	return (
		<div className="flex flex-col">
			<div className="px-3 pb-2 pt-3">
				<input
					ref={inputRef}
					value={query}
					placeholder="Search nodes…"
					data-catalog-input
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={handleKeyDown}
					className="h-9 w-full rounded-xs bg-surface px-3 text-body text-text-primary outline-none placeholder:text-dimmed"
				/>
			</div>

			{categories.length === 0 ? (
				<div className="px-4 py-4 text-body text-dimmed">No nodes found</div>
			) : searching ? (
				<div ref={listRef} className="max-h-[22rem] overflow-y-auto pb-1">
					{categories.map((category) => (
						<div key={category.key}>
							<DropdownMenuLabel>{category.label}</DropdownMenuLabel>
							{category.packages.flatMap((entry) =>
								entry.nodes.map((node) => <NodeItem key={`${node.packageName}/${node.nodeName}`} node={node} onSelect={onSelect} />),
							)}
						</div>
					))}
				</div>
			) : (
				<div className="pb-1">
					{categories.map((category) => (
						<DropdownMenuSub key={category.key}>
							<DropdownMenuSubTrigger>
								<span className="flex-1">{category.label}</span>
								<span className="text-xs text-dimmed">{category.total}</span>
								<ChevronRight size={14} strokeWidth={1.5} />
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-[22rem] w-72 overflow-y-auto">
								{multiPackage
									? category.packages.map((entry) => (
											<div key={entry.packageName}>
												<DropdownMenuLabel className="text-dimmed">{entry.packageName}</DropdownMenuLabel>
												{entry.nodes.map((node) => (
													<NodeItem key={node.nodeName} node={node} onSelect={onSelect} />
												))}
											</div>
										))
									: category.packages.flatMap((entry) =>
											entry.nodes.map((node) => <NodeItem key={node.nodeName} node={node} onSelect={onSelect} />),
										)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					))}
				</div>
			)}
		</div>
	);
}
