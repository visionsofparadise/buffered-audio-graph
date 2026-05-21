import { FolderOpen, Plus } from "lucide-react";
import { HomeGraph } from "../components/HomeGraph";
import { Barcode } from "../components/Barcode";

/**
 * Home screen for the design-system demo.
 *
 * BAGMAN wordmark top-left, a decorative graph centerpiece in the middle (see
 * `HomeGraph`), and the New / Open actions anchored bottom-right. Recent
 * graphs are no longer rendered as a list — each one is an annotation
 * pointing to one of the graph's nodes, with hover highlighting the
 * connection between label and anchor.
 *
 * The home screen IS the new-tab entry point. The `+` button in the App tab
 * bar takes you here; from here, "New graph" creates a new tab, "Open graph"
 * opens one (no-op in the demo), and clicking a recent annotation opens that
 * file.
 */

interface RecentGraph {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly relativeTime: string;
}

const RECENT_GRAPHS: ReadonlyArray<RecentGraph> = [
	{
		id: "recent-1",
		name: "Podcast Episode 042 — Master",
		path: "~/Audio/Podcast/episode-042.bag",
		relativeTime: "Just now",
	},
	{
		id: "recent-2",
		name: "Interview Cleanup",
		path: "~/Audio/Interviews/cleanup-take-3.bag",
		relativeTime: "2 hours ago",
	},
	{
		id: "recent-3",
		name: "Album Pre-Master Chain",
		path: "~/Music/Project A/premaster.bag",
		relativeTime: "Yesterday",
	},
	{
		id: "recent-4",
		name: "Field Recording Denoise",
		path: "~/Field/2026-05-12-park.bag",
		relativeTime: "3 days ago",
	},
	{
		id: "recent-5",
		name: "Voiceover Stem Split",
		path: "~/Voice/stem-split.bag",
		relativeTime: "2 weeks ago",
	},
];

// Bar widths for the decorative home-screen barcode — randomized once at
// module load so the pattern reads as a real, irregular barcode. The count is
// sized so the rotated barcode runs roughly the length of the vertical
// wordmark beside it.
const HOME_BARCODE_WIDTHS = Array.from(
	{ length: 56 },
	() => 1 + Math.floor(Math.random() * 4),
);
const HOME_BARCODE_LENGTH =
	HOME_BARCODE_WIDTHS.reduce((total, barWidth) => total + barWidth, 0) +
	(HOME_BARCODE_WIDTHS.length - 1);

interface Props {
	readonly onNewGraph: () => void;
	readonly onOpenGraph: () => void;
	readonly onOpenRecent: (name: string) => void;
}

export function HomePage({ onNewGraph, onOpenGraph, onOpenRecent }: Props) {
	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-surface p-6">
			{/* Decorative top-right watermark — the product wordmark and a
			    vertical barcode (the horizontal Barcode rotated a quarter turn),
			    sitting behind the centerpiece graph. */}
			<div className="pointer-events-none absolute right-4 top-6 z-0 flex items-start gap-4">
				<span
					className="type-label text-dimmed"
					style={{ writingMode: "vertical-rl" }}
				>
					Buffered Audio Graph Manager
				</span>
				<div
					className="relative w-8"
					style={{ height: HOME_BARCODE_LENGTH }}
				>
					<div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rotate-90">
						<Barcode
							widths={HOME_BARCODE_WIDTHS}
							height={28}
							color="var(--color-border)"
						/>
					</div>
				</div>
			</div>

			<h1 className="type-display text-display-lg leading-none text-text-primary">
				BAGMAN
			</h1>

			<div className="relative z-10 min-h-0 flex-1">
				<HomeGraph recents={RECENT_GRAPHS} onOpenRecent={onOpenRecent} />
			</div>

			{/* Studio mark — balances the action buttons in the opposite corner.
			    pointer-events-none so it never intercepts a graph-anchor click. */}
			<span className="type-label pointer-events-none absolute bottom-6 left-6 z-20 text-dimmed">
				&copy; ZCROSS
			</span>

			<div className="absolute right-6 bottom-6 z-20 flex flex-col items-end gap-3">
				<button
					type="button"
					onClick={onNewGraph}
					className="flex w-fit items-center gap-2 px-4 py-2 text-body text-text-primary hover:bg-text-primary hover:text-surface"
				>
					<Plus size={16} strokeWidth={1.5} />
					<span>New graph</span>
				</button>
				<button
					type="button"
					onClick={onOpenGraph}
					className="flex w-fit items-center gap-2 px-4 py-2 text-body text-text-primary hover:bg-text-primary hover:text-surface"
				>
					<FolderOpen size={16} strokeWidth={1.5} />
					<span>Open graph</span>
				</button>
			</div>
		</div>
	);
}
