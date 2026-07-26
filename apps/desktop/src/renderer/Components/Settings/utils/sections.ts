export type SectionId = "packages" | "binaries" | "vst3ScanRoots";

export const SECTIONS: ReadonlyArray<{ readonly id: SectionId; readonly label: string }> = [
	{ id: "packages", label: "Packages" },
	{ id: "binaries", label: "Binaries" },
	{ id: "vst3ScanRoots", label: "VST3 scan roots" },
];
