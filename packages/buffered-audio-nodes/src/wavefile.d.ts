// wavefile@11 ships type declarations only at the package root (index.d.ts, an
// `export =` namespace). read-to-buffer.ts imports the CJS entry by explicit
// path — "wavefile/dist/wavefile" — so every runtime (tsup/esbuild, tsx, Node
// ESM, vitest) resolves the same file and tsup's `noExternal` can bundle it.
// That subpath has no declaration of its own; the imported value is cast to
// the real `import type * as Wavefile from "wavefile"` type at the use site.
declare module "wavefile/dist/wavefile";
