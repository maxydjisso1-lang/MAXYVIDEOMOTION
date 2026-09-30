import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT, type Brand } from "../engine/core/src/index.js";

export const TMP = join(REPO_ROOT, "tests/.tmp");
export const FIXTURES = join(REPO_ROOT, "tests/fixtures");
export const GENERATED = join(FIXTURES, "generated");

export async function freshDir(name: string): Promise<string> {
  const dir = join(TMP, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  return dir;
}

export function loadBrand(name: "maison-lune" | "volt-street"): Brand {
  return JSON.parse(readFileSync(join(REPO_ROOT, "examples/brands", name, "brand.json"), "utf8")) as Brand;
}

export interface CliResult<T = any> {
  code: number;
  json: { ok: boolean; data?: T; version?: string; code?: string; message?: string; hint?: string };
  stderr: string;
}

/** Drive the real CLI exactly like Claude does: `bve --json ...`. */
export function bve<T = any>(project: string | null, ...args: string[]): Promise<CliResult<T>> {
  const argv = [join(REPO_ROOT, "bin/bve.js"), ...(project ? ["--project", project] : []), "--json", ...args];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, windowsHide: true, env: { ...process.env, BVE_LOG_LEVEL: "warn" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolvePromise({ code: code ?? 1, json: JSON.parse(out), stderr: err });
      } catch {
        reject(new Error(`bve ${args.join(" ")} produced no JSON (exit ${code}):\n${out}\n${err.slice(-3000)}`));
      }
    });
  });
}

/** Same as bve() but throws with the engine's message when the command fails. */
export async function bveOk<T = any>(project: string | null, ...args: string[]): Promise<T> {
  const r = await bve<T>(project, ...args);
  if (!r.json.ok) throw new Error(`bve ${args.join(" ")} failed [${r.json.code}]: ${r.json.message}\n${r.json.hint ?? ""}\n${r.stderr.slice(-2000)}`);
  return r.json.data as T;
}
