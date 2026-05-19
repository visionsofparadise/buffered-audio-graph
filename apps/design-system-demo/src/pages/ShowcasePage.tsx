import { useState } from "react";
import { Knob, Fader, Meter, ButtonSelection, Button, Input, COLORMAP_POINTS, colormapGradient } from "@buffered-audio/design-system";

const CHROME = [
  { token: "void", hex: "#020204" },
  { token: "chrome-base", hex: "#0D0D0F" },
  { token: "chrome-surface", hex: "#1E1E23" },
  { token: "chrome-raised", hex: "#28282E" },
  { token: "chrome-border", hex: "#2A2A30" },
  { token: "chrome-border-subtle", hex: "#1F1F24" },
  { token: "chrome-text", hex: "#B8B8C0" },
  { token: "chrome-text-secondary", hex: "#6E6E78" },
  { token: "chrome-text-dim", hex: "#44444C" },
] as const;

const BRAND = [
  { token: "primary", hex: "#D76405", label: "Burnt Orange" },
  { token: "secondary", hex: "#0F1446", label: "Lava Blue" },
] as const;

const STATE = [
  { token: "state-rendered", hex: "#34D399", label: "Rendered" },
  { token: "state-stale", hex: "#FBBF24", label: "Stale" },
  { token: "state-processing", hex: "#60A5FA", label: "Processing" },
  { token: "state-error", hex: "#F87171", label: "Error" },
  { token: "state-bypassed", hex: "#44444C", label: "Bypassed" },
] as const;

const EDGE = [
  { token: "edge-idle", hex: "#2A2A30", label: "Idle" },
  { token: "edge-active", hex: "#60A5FA", label: "Active" },
  { token: "edge-complete", hex: "#34D399", label: "Complete" },
] as const;

const LOUDNESS_LAVA = [
  { token: "waveform", hex: "#5EC4B6", label: "Waveform" },
  { token: "rms", hex: "#1A7A6C", label: "RMS" },
  { token: "lufs", hex: "#34D399", label: "LUFS" },
  { token: "peak", hex: "#FB7185", label: "Peak" },
] as const;

const LOUDNESS_VIRIDIS = [
  { token: "waveform", hex: "#E91E90", label: "Waveform" },
  { token: "rms", hex: "#8B1A5C", label: "RMS" },
  { token: "lufs", hex: "#38BDF8", label: "LUFS" },
  { token: "peak", hex: "#FF1744", label: "Peak" },
] as const;


const TYPE_SCALE = [
  { token: "text-3xl", rem: "3rem", usage: "Logo / display" },
  { token: "text-2xl", rem: "2rem", usage: "Hero" },
  { token: "text-xl", rem: "1.5rem", usage: "Large headings" },
  { token: "text-lg", rem: "1.125rem", usage: "View titles" },
  { token: "text-md", rem: "1rem", usage: "Section headers" },
  { token: "text-base", rem: "0.875rem", usage: "Primary UI text" },
  { token: "text-sm", rem: "0.8125rem", usage: "Labels, parameters" },
  { token: "text-xs", rem: "0.75rem", usage: "Axis ticks, metadata" },
] as const;

function Section({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4 border-b border-chrome-border-subtle p-6">
      <p className="font-technical text-[length:var(--text-sm)] uppercase tracking-[0.1em] text-primary">{label}</p>
      {children}
    </div>
  );
}

function ControlsDemo() {
  const [knobA, setKnobA] = useState(0.65);
  const [knobB, setKnobB] = useState(0.3);
  const [knobC, setKnobC] = useState(0.85);
  const [faderA, setFaderA] = useState(0.75);
  const [faderB, setFaderB] = useState(0.5);
  const [selection, setSelection] = useState("LUFS");

  return (
    <div className="grid grid-cols-4 gap-6">
      <div className="flex flex-col gap-2">
        <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Knobs</span>
        <div className="flex items-end gap-4">
          <Knob value={knobA} label="Gain" onChange={setKnobA} />
          <Knob value={knobB} label="Freq" onChange={setKnobB} />
          <Knob value={knobC} label="Mix" onChange={setKnobC} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Faders</span>
        <div className="flex items-end gap-4">
          <Fader value={faderA} label="Vol" onChange={setFaderA} />
          <Fader value={faderB} label="Pan" onChange={setFaderB} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Meters</span>
        <div className="flex items-end gap-2">
          <Meter level={0.7} animated />
          <Meter level={0.5} animated />
          <Meter level={0.85} animated />
          <Meter level={0.3} animated />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Button Selection</span>
        <ButtonSelection options={["Peak", "RMS", "LUFS"]} active={selection} onSelect={setSelection} />
        <ButtonSelection options={["Mono", "Stereo", "Mid/Side", "Surround"]} active="Stereo" columns={2} />
      </div>
    </div>
  );
}

export function ShowcasePage() {
  return (
    <div>
      <div className="flex flex-col gap-2 bg-void p-6">
        <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.15em] text-chrome-text-dim">Design System</span>
        <h1 className="font-display text-[length:var(--text-3xl)] font-bold leading-none tracking-tight text-chrome-text">
          ENGINEERING
        </h1>
        <p className="font-body text-[length:var(--text-lg)] text-chrome-text-secondary">Audio Processing Workstation</p>
        <span className="font-technical text-[length:var(--text-xs)] text-chrome-text-dim">v0.1.0</span>
      </div>

      <div className="flex border-b border-chrome-border-subtle">
        {CHROME.map((color) => {
          const isLight = parseInt(color.hex.slice(5, 7), 16) > 100;

          return (
            <div
              key={color.token}
              className="flex flex-1 flex-col justify-end p-3"
              style={{ backgroundColor: color.hex, minHeight: 72 }}
            >
              <span className={`font-technical text-[length:var(--text-xs)] ${isLight ? "text-chrome-base" : "text-chrome-text"}`}>
                {color.token}
              </span>
              <span className={`font-technical text-[length:var(--text-xs)] ${isLight ? "text-chrome-base" : "text-chrome-text-dim"}`}>
                {color.hex}
              </span>
            </div>
          );
        })}
      </div>

      <Section label="Brand">
        <div className="flex gap-6">
          {BRAND.map((color) => (
            <div key={color.token} className="flex items-center gap-3">
              <div className="h-10 w-10" style={{ backgroundColor: color.hex }} />
              <div>
                <span className="font-body text-[length:var(--text-base)] text-chrome-text">{color.label}</span>
                <span className="block font-technical text-[length:var(--text-xs)] text-chrome-text-dim">{color.hex}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section label="States">
        <div className="flex gap-6">
          {STATE.map((color) => (
            <div key={color.token} className="flex items-center gap-3">
              <div className="h-10 w-10" style={{ backgroundColor: color.hex }} />
              <div>
                <span className="font-body text-[length:var(--text-base)] text-chrome-text">{color.label}</span>
                <span className="block font-technical text-[length:var(--text-xs)] text-chrome-text-dim">{color.hex}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section label="Edges">
        <div className="flex gap-6">
          {EDGE.map((color) => (
            <div key={color.token} className="flex items-center gap-3">
              <div className="flex items-center" style={{ width: 40 }}>
                <svg width={40} height={4}>
                  <line x1={0} y1={2} x2={40} y2={2} stroke={color.hex} strokeWidth={2} />
                </svg>
              </div>
              <div>
                <span className="font-body text-[length:var(--text-base)] text-chrome-text">{color.label}</span>
                <span className="block font-technical text-[length:var(--text-xs)] text-chrome-text-dim">{color.hex}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section label="Colormaps">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Lava</span>
            <div className="relative h-8" style={{ background: colormapGradient(COLORMAP_POINTS.lava) }}>
              <div className="absolute inset-0 flex items-center justify-around px-4">
                {LOUDNESS_LAVA.map((color) => (
                  <div key={color.token} className="flex items-center gap-2">
                    <div className="h-3 w-3" style={{ backgroundColor: color.hex }} />
                    <span className="font-technical text-[length:var(--text-xs)] uppercase" style={{ color: color.hex }}>{color.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-between font-technical text-[length:var(--text-xs)] tabular-nums text-chrome-text-dim">
              <span>{"\u2212\u221E"}</span><span>{"\u2212"}96</span><span>{"\u2212"}72</span><span>{"\u2212"}48</span><span>{"\u2212"}24</span><span>{"\u2212"}12</span><span>{"\u2212"}6</span><span>0 dB</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Viridis</span>
            <div className="relative h-8" style={{ background: colormapGradient(COLORMAP_POINTS.viridis) }}>
              <div className="absolute inset-0 flex items-center justify-around px-4">
                {LOUDNESS_VIRIDIS.map((color) => (
                  <div key={color.token} className="flex items-center gap-2">
                    <div className="h-3 w-3" style={{ backgroundColor: color.hex }} />
                    <span className="font-technical text-[length:var(--text-xs)] uppercase" style={{ color: color.hex }}>{color.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-between font-technical text-[length:var(--text-xs)] tabular-nums text-chrome-text-dim">
              <span>{"\u2212\u221E"}</span><span>{"\u2212"}96</span><span>{"\u2212"}72</span><span>{"\u2212"}48</span><span>{"\u2212"}24</span><span>{"\u2212"}12</span><span>{"\u2212"}6</span><span>0 dB</span>
            </div>
          </div>
        </div>
      </Section>

      <Section label="Typography">
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 flex flex-col gap-1">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Display — Bricolage Grotesque</span>
            <span className="font-body text-[length:var(--text-sm)] text-chrome-text-secondary">Hero text, logo, large display headings</span>
            <div className="mt-2 flex flex-col gap-2">
              <span className="font-display text-[length:var(--text-3xl)] font-bold leading-none tracking-tight text-chrome-text">Engineering</span>
              <span className="font-display text-[length:var(--text-2xl)] font-semibold leading-none tracking-tight text-chrome-text">Session Builder</span>
              <span className="font-display text-[length:var(--text-xl)] font-medium leading-none text-chrome-text">Processing Pipeline</span>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Scale</span>
            {TYPE_SCALE.map((step) => (
              <div key={step.token} className="flex items-baseline justify-between">
                <span className="font-technical text-[length:var(--text-xs)] text-chrome-text-secondary">{step.token}</span>
                <span className="font-technical text-[length:var(--text-xs)] tabular-nums text-chrome-text-dim">{step.rem}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Body — Outfit</span>
            <span className="font-body text-[length:var(--text-sm)] text-chrome-text-secondary">Readable body text, descriptions, node names</span>
            <div className="mt-2 flex flex-col gap-2">
              <span className="font-body text-[length:var(--text-xl)] text-chrome-text">Voice Denoise</span>
              <span className="font-body text-[length:var(--text-lg)] text-chrome-text">Processing pipeline for podcast audio restoration</span>
              <span className="font-body text-[length:var(--text-base)] text-chrome-text-secondary">Secondary label text at body sizes</span>
            </div>
          </div>

          <div className="col-span-2 flex flex-col gap-1">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Technical — JetBrains Mono</span>
            <span className="font-body text-[length:var(--text-sm)] text-chrome-text-secondary">Units, values, axes, labels, buttons, tags, timecodes</span>
            <div className="mt-2 flex flex-col gap-2">
              <span className="font-technical text-[length:var(--text-xl)] tabular-nums text-chrome-text">{"\u2212"}24.5{"\u2009"}dB{"  "}00:01:32.450{"  "}44{"\u2009"}100{"\u2009"}Hz</span>
              <span className="font-technical text-[length:var(--text-base)] uppercase tracking-[0.06em] text-chrome-text-secondary">RENDER{"  "}BYPASS{"  "}EXPORT{"  "}DELETE</span>
            </div>
          </div>
        </div>
      </Section>

      <Section label="Font Pairing">
        <div className="grid grid-cols-3 gap-4">
          {[
            { name: "Voice Denoise", fields: [
              { label: "Threshold", value: "\u221224.5 dB", technical: true },
              { label: "Reduction", value: "12 dB", technical: true },
              { label: "Position", value: "00:01:32.450", technical: true },
            ]},
            { name: "Normalize", fields: [
              { label: "Ceiling", value: "\u22121.0 dB", technical: true },
              { label: "Algorithm", value: "LUFS", technical: true },
              { label: "Sample Rate", value: "44 100 Hz", technical: true },
            ]},
            { name: "Write", fields: [
              { label: "Path", value: "podcast-clean.wav", technical: false },
              { label: "Bit Depth", value: "24 bit", technical: true },
              { label: "Duration", value: "00:05:12.000", technical: true },
            ]},
          ].map((node) => (
            <div key={node.name} className="flex flex-col gap-3 bg-chrome-surface p-4">
              <span className="font-body text-[length:var(--text-base)] font-medium text-chrome-text">{node.name}</span>
              {node.fields.map((field) => (
                <div key={field.label} className="flex items-baseline justify-between">
                  <span className="font-technical text-[length:var(--text-sm)] uppercase tracking-[0.06em] text-chrome-text-secondary">{field.label}</span>
                  <span className={`text-[length:var(--text-sm)] text-chrome-text ${field.technical ? "font-technical tabular-nums" : "font-body"}`}>{field.value}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Section>

      <Section label="Components">
        <div className="grid grid-cols-3 gap-6">
          <div className="flex flex-col gap-2">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Buttons</span>
            <div className="flex items-center gap-3">
              <Button variant="primary">Export</Button>
              <Button variant="secondary">Render</Button>
              <Button variant="ghost">Cancel</Button>
              <Button disabled>Disabled</Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Inputs</span>
            <div className="flex flex-col gap-3">
              <Input label="Text" placeholder="Enter value…" />
              <Input type="number" label="Number" defaultValue="-24.5" />
              <div className="flex flex-col gap-1">
                <label className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-secondary">File</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    defaultValue="podcast-clean.wav"
                    className="flex-1 bg-void px-2 py-1.5 font-technical text-[length:var(--text-sm)] text-chrome-text outline-none focus:ring-1 focus:ring-secondary"
                  />
                  <Button variant="secondary">Browse</Button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Menu</span>
            <div className="flex w-48 flex-col py-1 bg-chrome-raised">
              {["Noise Reduction", "EQ", "Compressor"].map((item, index) => (
                <div
                  key={item}
                  className={`mx-2 my-0.5 cursor-default font-technical text-[length:var(--text-sm)] uppercase tracking-[0.06em] text-chrome-text ${index === 1 ? "bg-interactive-hover" : ""}`}
                >
                  {item}
                </div>
              ))}
              <div className="mx-2 my-1 h-px bg-chrome-border-subtle" />
              {["Limiter", "Normalize"].map((item) => (
                <div key={item} className="mx-2 my-0.5 cursor-default font-technical text-[length:var(--text-sm)] uppercase tracking-[0.06em] text-chrome-text">
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section label="Controls">
        <ControlsDemo />
      </Section>

      <Section label="Tabs">
        <div className="flex flex-col gap-2">
          <span className="font-technical text-[length:var(--text-xs)] uppercase tracking-[0.08em] text-chrome-text-dim">Navigation</span>
          <div className="flex items-center bg-chrome-surface">
            {["Showcase", "Home", "Graph", "Spectral"].map((tab, index) => (
              <span
                key={tab}
                className={`mx-2 cursor-default font-technical text-[length:var(--text-sm)] uppercase tracking-[0.06em] transition-colors ${
                  index === 0
                    ? "bg-primary text-void"
                    : "text-chrome-text-secondary hover:text-chrome-text"
                }`}
              >
                {tab}
              </span>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}
