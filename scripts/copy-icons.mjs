import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "icons");
const dest = resolve(here, "..", "dist", "icons");

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
