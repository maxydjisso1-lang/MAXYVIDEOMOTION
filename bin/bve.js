#!/usr/bin/env node
// Runs the TypeScript CLI directly (no build step needed); `npm run build` produces dist/ for packaging.
import { register } from "tsx/esm/api";

register();
await import("../engine/cli/src/bin.ts");
