import { useState } from "react";
import {
	Bell,
	Copy,
	Download,
	FileText,
	Play,
	Save,
	Settings,
	Trash2,
} from "lucide-react";
import {
	Button,
	ButtonSelection,
	DropdownButton,
	Fader,
	IconButton,
	Input,
	Knob,
	Meter,
	Select,
	Toggle,
	accentPrimary,
	accentSecondary,
	border,
	categorySource,
	categoryTarget,
	categoryTransform,
	dimmed,
	elevated,
	meterGreen,
	meterYellow,
	surface,
	textPrimary,
	textSecondary,
	type MenuItem,
} from "@buffered-audio/design-system";

const COLOR_TOKENS: ReadonlyArray<{ readonly token: string; readonly hex: string }> = [
	{ token: "surface", hex: surface },
	{ token: "elevated", hex: elevated },
	{ token: "border", hex: border },
	{ token: "dimmed", hex: dimmed },
	{ token: "text-secondary", hex: textSecondary },
	{ token: "text-primary", hex: textPrimary },
	{ token: "accent-primary", hex: accentPrimary },
	{ token: "accent-secondary", hex: accentSecondary },
	{ token: "category-source", hex: categorySource },
	{ token: "category-transform", hex: categoryTransform },
	{ token: "category-target", hex: categoryTarget },
	{ token: "meter-green", hex: meterGreen },
	{ token: "meter-yellow", hex: meterYellow },
];

const SELECT_OPTIONS: ReadonlyArray<string> = [
	"Sine",
	"Triangle",
	"Square",
	"Sawtooth",
	"Noise",
];

const DROPDOWN_ITEMS: ReadonlyArray<MenuItem> = [
	{ kind: "action", label: "Open", icon: FileText, shortcut: "Ctrl+O" },
	{ kind: "action", label: "Save", icon: Save, shortcut: "Ctrl+S" },
	{ kind: "action", label: "Duplicate", icon: Copy, shortcut: "Ctrl+D" },
	{ kind: "separator" },
	{ kind: "action", label: "Export", icon: Download },
	{ kind: "action", label: "Settings", icon: Settings, disabled: true },
];

function Section({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3 border-b border-border px-6 py-5">
			<h2 className="type-label text-text-secondary">{label}</h2>
			<div className="flex flex-col gap-4">{children}</div>
		</section>
	);
}

export function ShowcasePage() {
	const [textValue, setTextValue] = useState("clean-take-04");
	const [numberValue, setNumberValue] = useState("-24.5");
	const [selectValue, setSelectValue] = useState<string>("Triangle");
	const [toggleA, setToggleA] = useState(true);
	const [toggleB, setToggleB] = useState(false);
	const [knob32, setKnob32] = useState(0.4);
	const [knob40, setKnob40] = useState(0.65);
	const [knob56, setKnob56] = useState(0.85);
	const [faderA, setFaderA] = useState(0.7);
	const [faderB, setFaderB] = useState(0.45);
	const [selA, setSelA] = useState("Stereo");
	const [selB, setSelB] = useState("LUFS");

	return (
		<div className="scrollbar-ruler min-h-0 flex-1 overflow-auto">
			<Section label="Buttons">
				<div className="flex flex-wrap items-center gap-3">
					<Button variant="default" size="lg">Default</Button>
					<Button variant="outline" size="lg">Outline</Button>
					<Button variant="ghost" size="lg">Ghost</Button>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Button variant="default" size="md">Default</Button>
					<Button variant="outline" size="md">Outline</Button>
					<Button variant="ghost" size="md">Ghost</Button>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Button variant="default" size="sm">Default</Button>
					<Button variant="outline" size="sm">Outline</Button>
					<Button variant="ghost" size="sm">Ghost</Button>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Button variant="default" disabled>Disabled</Button>
					<Button variant="outline" disabled>Disabled</Button>
					<Button variant="ghost" disabled>Disabled</Button>
				</div>
			</Section>

			<Section label="Icon Buttons">
				<div className="flex flex-wrap items-center gap-3">
					<IconButton icon={Play} label="Play" variant="default" size="lg" />
					<IconButton icon={Save} label="Save" variant="outline" size="lg" />
					<IconButton icon={Bell} label="Notifications" variant="ghost" size="lg" />
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<IconButton icon={Play} label="Play" variant="default" size="md" />
					<IconButton icon={Save} label="Save" variant="outline" size="md" />
					<IconButton icon={Bell} label="Notifications" variant="ghost" size="md" />
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<IconButton icon={Trash2} label="Delete" variant="default" size="sm" />
					<IconButton icon={Trash2} label="Delete" variant="outline" size="sm" />
					<IconButton icon={Trash2} label="Delete" variant="ghost" size="sm" />
					<IconButton icon={Settings} label="Settings (disabled)" variant="ghost" disabled />
				</div>
			</Section>

			<Section label="Inputs">
				<div className="grid max-w-md grid-cols-2 gap-4">
					<Input label="Filename" value={textValue} onChange={setTextValue} />
					<Input label="Threshold (dB)" type="number" value={numberValue} onChange={setNumberValue} />
					<Input placeholder="No label" />
				</div>
			</Section>

			<Section label="Selects">
				<div className="max-w-xs">
					<Select
						label="Waveform"
						value={selectValue}
						options={SELECT_OPTIONS}
						onChange={setSelectValue}
					/>
				</div>
			</Section>

			<Section label="Toggles">
				<div className="flex items-center gap-3">
					<Toggle value={toggleA} label="Enabled" onChange={setToggleA} />
					<Toggle value={toggleB} label="Linked" onChange={setToggleB} />
				</div>
			</Section>

			<Section label="Dropdown Buttons">
				<div className="flex items-center gap-3">
					<DropdownButton
						trigger={<Button variant="outline">File…</Button>}
						items={DROPDOWN_ITEMS}
					/>
				</div>
			</Section>

			<Section label="Knobs">
				<div className="flex items-end gap-6">
					<Knob value={knob32} label="32px" size={32} onChange={setKnob32} />
					<Knob value={knob40} label="40px" size={40} onChange={setKnob40} />
					<Knob value={knob56} label="56px" size={56} onChange={setKnob56} />
				</div>
			</Section>

			<Section label="Faders">
				<div className="flex items-end gap-6">
					<Fader value={faderA} onChange={setFaderA} />
					<Fader value={faderB} label="Gain" onChange={setFaderB} />
				</div>
			</Section>

			<Section label="Meters">
				<div className="flex items-end gap-3">
					<Meter level={0.15} />
					<Meter level={0.45} />
					<Meter level={0.7} />
					<Meter level={0.9} />
					<Meter level={0.6} animated />
					<Meter level={0.6} animated />
				</div>
			</Section>

			<Section label="Button Selections">
				<div className="grid max-w-md gap-4">
					<div className="flex flex-col gap-2">
						<span className="type-label text-text-secondary">2 columns</span>
						<ButtonSelection
							options={["Mono", "Stereo", "Mid/Side", "Multi"]}
							active={selA}
							onSelect={setSelA}
							columns={2}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<span className="type-label text-text-secondary">4 columns</span>
						<ButtonSelection
							options={["Peak", "RMS", "LUFS", "True"]}
							active={selB}
							onSelect={setSelB}
							columns={4}
						/>
					</div>
				</div>
			</Section>

			<Section label="Color Tokens">
				<div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
					{COLOR_TOKENS.map((color) => (
						<div
							key={color.token}
							className="flex items-center gap-3 rounded-xs bg-elevated p-2"
						>
							<span
								className="inline-block h-8 w-8 shrink-0 rounded-xs"
								style={{ backgroundColor: color.hex }}
								aria-hidden="true"
							/>
							<div className="flex min-w-0 flex-col">
								<span className="type-label text-text-primary">{color.token}</span>
								<span className="type-value text-label tabular-nums text-text-secondary">
									{color.hex}
								</span>
							</div>
						</div>
					))}
				</div>
			</Section>

			<Section label="Typography">
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-1">
						<span className="type-label text-text-secondary">type-display</span>
						<span className="type-display text-text-primary">DISPLAY HEADING</span>
					</div>
					<div className="flex flex-col gap-1">
						<span className="type-label text-text-secondary">type-label</span>
						<span className="type-label text-text-primary">UPPERCASE LABEL</span>
					</div>
					<div className="flex flex-col gap-1">
						<span className="type-label text-text-secondary">type-value</span>
						<span className="type-value text-text-primary tabular-nums">
							−24.5 dB · 44 100 Hz · 00:01:32.450
						</span>
					</div>
				</div>
			</Section>
		</div>
	);
}
