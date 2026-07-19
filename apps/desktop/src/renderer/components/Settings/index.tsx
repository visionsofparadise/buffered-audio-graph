import { retrack } from "opshot/react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "../../utils/cn";
import type { AppContext } from "../../models/Context";
import { Button } from "../Button";
import { BinariesSection } from "./BinariesSection";
import { PackagesSection } from "./PackagesSection";
import { Vst3ScanRootsSection } from "./Vst3ScanRootsSection";

interface Props {
	readonly isOpen: boolean;
	readonly onClose: () => void;
	readonly context: AppContext;
}

type SectionId = "packages" | "binaries" | "vst3ScanRoots";

const SECTIONS: ReadonlyArray<{ readonly id: SectionId; readonly label: string }> = [
	{ id: "packages", label: "Packages" },
	{ id: "binaries", label: "Binaries" },
	{ id: "vst3ScanRoots", label: "VST3 scan roots" },
];

export const Settings = retrack<Props>(({ isOpen, onClose, context }: Props) => {
	const [activeSection, setActiveSection] = useState<SectionId>("packages");

	const handleEscape = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Escape") {
				onClose();
			}
		},
		[onClose],
	);

	useEffect(() => {
		if (!isOpen) return;

		document.addEventListener("keydown", handleEscape);

		return () => {
			document.removeEventListener("keydown", handleEscape);
		};
	}, [isOpen, handleEscape]);

	const handleOverlayClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (event.target === event.currentTarget) {
				onClose();
			}
		},
		[onClose],
	);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
			onClick={handleOverlayClick}
		>
			<div className="bg-elevated w-[640px] max-h-[80vh] min-h-[480px] flex flex-col overflow-hidden rounded-xs shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
				<div className="flex items-center justify-between px-6 py-4">
					<h2 className="type-label text-body text-text-primary">Settings</h2>
					<Button variant="ghost" size="sm" onClick={onClose}>
						Close
					</Button>
				</div>

				<div className="flex flex-1 min-h-0">
					<nav className="w-40 shrink-0 py-3 pl-2">
						{SECTIONS.map((section) => (
							<button
								key={section.id}
								type="button"
								onClick={() => setActiveSection(section.id)}
								className={cn(
									"w-full text-left px-4 py-2 text-body",
									section.id === activeSection
										? "bg-text-primary text-surface"
										: "text-text-secondary hover:text-text-primary",
								)}
							>
								{section.label}
							</button>
						))}
					</nav>

					<div className="flex-1 overflow-y-auto px-6 py-5">
						{activeSection === "packages" && <PackagesSection context={context} />}
						{activeSection === "binaries" && <BinariesSection context={context} />}
						{activeSection === "vst3ScanRoots" && <Vst3ScanRootsSection context={context} />}
					</div>
				</div>
			</div>
		</div>
	);
});
