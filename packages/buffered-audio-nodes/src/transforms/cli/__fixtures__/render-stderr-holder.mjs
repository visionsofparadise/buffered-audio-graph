#!/usr/bin/env node
// Renders a WAV through a CLI node whose command leaves a grandchild holding only its stderr, then prints
// "settled". The test measures from that line to this process's exit. Usage: render-stderr-holder.mjs <input> <output>

import process from "node:process";
import { cli, readWav, write } from "../../../../dist/index.js";

const [input, output] = process.argv.slice(2);
const source = readWav(input);
const holder = cli({ command: "sh", args: ["-c", "sleep 4 >/dev/null </dev/null & exec cat"] });
const target = write(output);

source.to(holder);
holder.to(target);

await source.createRenderJob().render();

process.stdout.write("settled\n");
