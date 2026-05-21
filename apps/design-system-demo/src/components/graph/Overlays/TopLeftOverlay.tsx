import { Plus } from "lucide-react";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@buffered-audio/design-system";

/**
 * TopLeftOverlay — Add Node trigger.
 *
 * The primary action of the graph workspace. Lists every concrete node in
 * `packages/buffered-audio-nodes/src/{sources, transforms, targets}/` grouped
 * by category. Each entry's `label` and `description` are the verbatim
 * `moduleName` and `moduleDescription` statics exported from that node's
 * `index.ts` — the demo is a UI showcase and intentionally does not depend on
 * the nodes package at runtime, so the list is copied in rather than imported.
 */

interface NodeListItem {
	readonly id: string;
	readonly label: string;
	readonly description: string;
}

interface CategoryGroup {
	readonly label: string;
	readonly nodes: ReadonlyArray<NodeListItem>;
}

const NODE_CATALOG: ReadonlyArray<CategoryGroup> = [
	{
		label: "Sources",
		nodes: [
			{
				id: "read",
				label: "Read",
				description: "Read audio from a file",
			},
		],
	},
	{
		label: "Transforms",
		nodes: [
			{
				id: "crest-reduce",
				label: "Crest Reduce",
				description:
					"Content-adaptive, magnitude-preserving, phase-only crest-factor reducer — a pre-limiter headroom stage that rearranges signal phase to flatten true-peak excursions without changing the magnitude spectrum, never increasing crest factor",
			},
			{
				id: "cut",
				label: "Cut",
				description: "Remove a region of audio",
			},
			{
				id: "de-bleed",
				label: "De-Bleed Adaptive",
				description:
					"Adaptive (MEF FDAF Kalman + MWF + MSAD) reference-based microphone bleed reduction. Stages 1+2 are MEF Meyer-Elshamy-Fingscheidt 2020; Stage 3 is Lukin-Todd 2D NLM+DFTT post-filter.",
			},
			{
				id: "deep-filter-net-3",
				label: "DeepFilterNet3 (Denoiser)",
				description:
					"Remove background noise from speech using DeepFilterNet3 (48 kHz full-band CRN)",
			},
			{
				id: "dither",
				label: "Dither",
				description: "Add shaped noise to reduce quantization distortion",
			},
			{
				id: "downmix-mono",
				label: "Downmix Mono",
				description:
					"Mix all input channels to a single mono channel by averaging",
			},
			{
				id: "dtln",
				label: "DTLN (Denoiser)",
				description:
					"Remove background noise from speech using DTLN neural network",
			},
			{
				id: "duplicate-channels",
				label: "Duplicate Channels",
				description:
					"Duplicate a mono signal into multiple identical output channels",
			},
			{
				id: "ffmpeg",
				label: "FFmpeg",
				description: "Process audio through FFmpeg filters",
			},
			{
				id: "gain",
				label: "Gain",
				description: "Adjust signal level by a fixed amount in dB",
			},
			{
				id: "htdemucs",
				label: "HTDemucs (Stem Separator)",
				description:
					"Rebalance stem volumes using HTDemucs source separation",
			},
			{
				id: "kim-vocal-2",
				label: "Kim Vocal 2 (Stem Separator)",
				description:
					"Isolate dialogue from background using MDX-Net vocal separation",
			},
			{
				id: "loudness-normalize",
				label: "Loudness Normalize",
				description:
					"Measure integrated loudness (BS.1770) and apply a single linear gain to hit a target LUFS — no limiting, no dynamics",
			},
			{
				id: "loudness-target",
				label: "Loudness Target",
				description:
					"Peak-aware content-adaptive curve fitting (LUFS, true-peak, LRA) via a single combined gain envelope with a peak-respecting two-stage smoother. The upper-arm peak anchor jointly iterates with the body gain to land both LUFS and true-peak targets in one envelope.",
			},
			{
				id: "normalize",
				label: "Normalize",
				description: "Adjust peak or loudness level to a target ceiling",
			},
			{
				id: "pad",
				label: "Pad",
				description: "Add silence to start or end of audio",
			},
			{
				id: "pan",
				label: "Pan",
				description:
					"Position mono signal in stereo field or adjust stereo balance",
			},
			{
				id: "phase",
				label: "Phase",
				description: "Invert or rotate signal phase",
			},
			{
				id: "reverse",
				label: "Reverse",
				description: "Reverse audio playback direction",
			},
			{
				id: "splice",
				label: "Splice",
				description: "Replace a region of audio with processed content",
			},
			{
				id: "trim",
				label: "Trim",
				description: "Remove silence from start and end",
			},
			{
				id: "true-peak-normalize",
				label: "True Peak Normalize",
				description:
					"Measure source true peak (4× upsampled, BS.1770-4 style) and apply a single linear gain to hit a target dBTP",
			},
			{
				id: "vst3",
				label: "VST3",
				description:
					"Host a chain of VST3 effect plugins via Pedalboard (whole-file offline mode)",
			},
		],
	},
	{
		label: "Targets",
		nodes: [
			{
				id: "loudness-stats",
				label: "Loudness Stats",
				description:
					"Measure integrated loudness, true peak, and loudness range per EBU R128, plus an amplitude-distribution histogram",
			},
			{
				id: "spectrogram",
				label: "Spectrogram",
				description: "Generate spectrogram visualization data",
			},
			{
				id: "waveform",
				label: "Waveform",
				description: "Generate waveform visualization data",
			},
			{
				id: "write",
				label: "Write",
				description: "Write audio to a file",
			},
		],
	},
];

interface Props {
	readonly onAddNode?: (nodeId: string) => void;
}

export function TopLeftOverlay({ onAddNode }: Props) {
	return (
		<div className="absolute left-3 top-3 z-10">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					{/* Same treatment as the rest of the top row: transparent against
					    the canvas, white highlight on hover, active-inversion while
					    the node menu is open. */}
					<Button
						variant="ghost"
						size="lg"
						icon={Plus}
						className="text-text-primary hover:bg-text-primary hover:text-surface data-[state=open]:bg-text-primary data-[state=open]:text-surface data-[state=open]:hover:text-surface"
					>
						ADD NODE
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					side="bottom"
					align="start"
					className="max-h-[calc(100vh-120px)] w-80 overflow-y-auto"
				>
					{NODE_CATALOG.map((group, groupIndex) => (
						<div key={group.label}>
							{groupIndex > 0 && <DropdownMenuSeparator />}
							<DropdownMenuLabel>{group.label}</DropdownMenuLabel>
							{group.nodes.map((node) => (
								<DropdownMenuItem
									key={node.id}
									className="flex-col items-start gap-0.5"
									onSelect={() => {
										onAddNode?.(node.id);
									}}
								>
									<span>{node.label}</span>
									{/* Sentence-case description, capped at three lines so a
									    long blurb can't stretch the row. Dimmed via opacity so
									    it follows the row's text color in both rest and
									    highlighted states. */}
									<span className="line-clamp-3 whitespace-normal text-xs normal-case leading-snug tracking-normal opacity-60">
										{node.description}
									</span>
								</DropdownMenuItem>
							))}
						</div>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
