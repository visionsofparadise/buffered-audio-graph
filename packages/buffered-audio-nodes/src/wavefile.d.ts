// wavefile@11 ships declarations only at the package root, so the explicit CJS subpath imported by read-to-buffer.ts has none — this ambient stub declares it (the value is cast to the root type at the use site).
declare module "wavefile/dist/wavefile";
