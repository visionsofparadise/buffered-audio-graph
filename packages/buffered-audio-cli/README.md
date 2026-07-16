# @buffered-audio/cli

Render `.bag` graph definition files from the command line. The `bag` binary resolves the node packages a bag pins, builds a node registry, and runs the render.

## Install

```
npm i -g @buffered-audio/cli
```

## Usage

```
bag --version
bag render graph.bag
```

Rendering a bag executes the code the packages it names contain. Resolved packages run with full system access — render only bags you trust.

### `render <file>`

| Flag | Description |
| --- | --- |
| `--param <name=value>` | Bind a `{{name}}` template placeholder in the bag. Repeatable. |
| `--chunk-size <samples>` | Chunk size in samples. |
| `--high-water-mark <count>` | Stream backpressure high water mark. |
| `--no-install` | Disable on-demand fetch; fail if a pin cannot be satisfied locally. |
| `--resolve <name=path>` | Override a package pin with a local directory. Repeatable. |

### `process --pipeline <file>`

Run an async audio processing pipeline from a TypeScript file whose default export is a source node.

## Package resolution

Each distinct `(packageName, packageVersion)` pair pinned by the bag's nodes resolves once, in order:

1. **`--resolve name=path` override** — a package-name mapping to a local directory, for unpublished packages under test. It applies to every pinned version of that package with a warning; TypeScript source is loaded directly.
2. **Ambient `node_modules`** — the copy installed in the working project, used only when its version equals the pin exactly.
3. **User cache** — `~/.buffered-audio/packages/{encodeURIComponent(name)}/{version}/`, populated by previous fetches (a scoped name is percent-encoded on disk, e.g. `%40buffered-audio%2Fnodes`).
4. **On-demand fetch** — `pacote` extracts `name@version` into the cache (install scripts disabled). Skipped under `--no-install`.

Fetch is on by default. `--no-install` turns an unsatisfiable pin into an error naming the package, the pin, and the flag.
