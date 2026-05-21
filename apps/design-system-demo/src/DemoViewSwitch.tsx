import { cn } from "@buffered-audio/design-system";

export type DemoView = "app" | "showcase";

interface Props {
	readonly view: DemoView;
	readonly onChange: (view: DemoView) => void;
}

const OPTIONS = ["App", "Showcase"] as const;

/**
 * DemoViewSwitch — top-of-screen strip for switching between the BAG app
 * shell and the primitive Showcase. Demo-only chrome; the real desktop app
 * has no equivalent.
 *
 * The App / Showcase options render as flush, square, full-height tabs —
 * the same treatment as the App tab bar's open-graph tabs (active-inversion,
 * no corner radius, edge-to-edge) — so the demo's view switch reads as part
 * of the same chrome family.
 */
export function DemoViewSwitch({ view, onChange }: Props) {
	const active = view === "app" ? "App" : "Showcase";

	return (
		<div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-elevated">
			<span className="type-label pl-3 text-text-secondary">DEMO VIEW</span>
			<div className="flex h-full">
				{OPTIONS.map((option) => {
					const isActive = option === active;

					return (
						<button
							key={option}
							type="button"
							onClick={() => {
								onChange(option === "App" ? "app" : "showcase");
							}}
							className={cn(
								"type-label flex h-full cursor-pointer items-center px-4",
								isActive
									? "bg-text-primary text-surface"
									: "text-text-secondary hover:text-text-primary",
							)}
						>
							{option}
						</button>
					);
				})}
			</div>
		</div>
	);
}
