# @buffered-audio/cli

Render `.bag` graph definition files from the command line. The `bag` binary resolves the node packages a bag pins, builds a node registry, and runs the render.

## Install

```bash
npm i -g @buffered-audio/cli
```

## Usage

```bash
bag --version
bag render graph.bag
```

Rendering a bag executes the code the packages it names contain. Resolved packages run with full system access — render only bags you trust.

### `render <file>`

| Flag                        | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `--param <name=value>`      | Bind a `{{name}}` template placeholder in the bag. Repeatable.      |
| `--chunk-size <samples>`    | Chunk size in samples.                                              |
| `--high-water-mark <count>` | Stream backpressure high water mark.                                |
| `--no-install`              | Disable on-demand fetch; fail if a pin cannot be satisfied locally. |
| `--resolve <name=path>`     | Override a package pin with a local directory. Repeatable.          |

## Package resolution

Each distinct `(packageName, packageVersion)` pair pinned by the bag's nodes resolves once, in order:

1. **`--resolve name=path` override** — a package-name mapping to a local directory, for unpublished packages under test. It applies to every pinned version of that package with a warning; TypeScript source is loaded directly.
2. **Ambient `node_modules`** — the copy installed in the working project, used only when its version equals the pin exactly.
3. **User cache** — `~/.buffered-audio/packages/{encodeURIComponent(name)}/{version}/`, populated by previous fetches (a scoped name is percent-encoded on disk, e.g. `%40buffered-audio%2Fnodes`).
4. **On-demand fetch** — `pacote` extracts `name@version` into the cache (install scripts disabled). Skipped under `--no-install`.

Fetch is on by default. `--no-install` turns an unsatisfiable pin into an error naming the package, the pin, and the flag.

## Interrupting a render

The first SIGINT or SIGTERM aborts every render the bag runs. The CLI waits for the renders to tear down, which ends their child processes, then prints `Aborted by SIGINT` or `Aborted by SIGTERM` to stderr and exits with code 130 for SIGINT or 143 for SIGTERM. A signal that arrives while packages are still resolving stops the CLI at once, with the same line and code, before any render starts. A signal that arrives once every render has succeeded changes nothing, and the CLI exits 0.

A repeat of either signal within 500 ms of the first counts as the same interrupt, because one Ctrl+C through `npm run` or `npx` can deliver two. A signal after that window forces the exit: the CLI prints `Forced exit by SIGINT` or `Forced exit by SIGTERM` and exits at once with that signal's code, without waiting for teardown.

The Write target of `@buffered-audio/nodes` 0.26.0 and later writes through a temporary file beside its output, named `<stem>.partial-<pid>-<hex><ext>`, and renames it onto the output path only when the render succeeds, so an interrupted render leaves the output path untouched. A forced exit can leave that temporary file behind, for you to delete.

## License

[MIT](LICENSE)
