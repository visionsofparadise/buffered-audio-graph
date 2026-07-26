import { retrack } from "opshot/react";
import { useState } from "react";
import { cn } from "../../utils/cn";
import type { AppContext } from "../../Models/Context";
import { Button } from "../UI/Button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../UI/Dialog";
import { BinariesSection } from "./BinariesSection";
import { PackagesSection } from "./PackagesSection";
import { Vst3ScanRootsSection } from "./Vst3ScanRootsSection";
import { SECTIONS, type SectionId } from "./utils/sections";

interface Props {
	readonly isOpen: boolean;
	readonly onClose: () => void;
	readonly context: AppContext;
}

export const Settings = retrack<Props>(({ isOpen, onClose, context }: Props) => {
	const [activeSection, setActiveSection] = useState<SectionId>("packages");

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="w-[640px] min-h-[480px]">
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="sm">
							Close
						</Button>
					</DialogClose>
				</DialogHeader>

				<div className="flex min-h-0 flex-1">
					<nav className="w-40 shrink-0 py-3 pl-2">
						{SECTIONS.map((section) => (
							<button
								key={section.id}
								type="button"
								onClick={() => setActiveSection(section.id)}
								className={cn(
									"w-full px-4 py-2 text-left text-body",
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
			</DialogContent>
		</Dialog>
	);
});
