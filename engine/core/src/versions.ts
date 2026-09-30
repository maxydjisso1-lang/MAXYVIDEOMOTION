import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BveError } from "./errors.js";
import { existsSync, readJson, sha256File, writeJsonAtomic } from "./fsutil.js";
import { DOC_SPECS, VERSIONED_DOCS, type DocKey } from "./docs.js";

export type VersionId = `v${string}`;

export interface VersionMeta {
  id: VersionId;
  parent: VersionId | null;
  /** Set when this version restored an earlier state (undo/checkout). History is never rewritten. */
  restores?: VersionId;
  createdAt: string;
  actor: "claude" | "user" | "engine";
  command: string;
  message: string;
  changed: DocKey[];
  docs: Partial<Record<DocKey, string>>;
}

export interface CommitInput {
  actor?: VersionMeta["actor"];
  command: string;
  message: string;
}

const pad = (n: number) => `v${String(n).padStart(4, "0")}` as VersionId;

/**
 * Snapshot versioning: each version stores a full copy of every decision document (they are
 * small). Undo restores the previous logical state as a NEW version.
 */
export class VersionStore {
  constructor(private readonly root: string) {}

  private dir(id: VersionId) {
    return join(this.root, "versions", id);
  }

  async list(): Promise<VersionMeta[]> {
    const base = join(this.root, "versions");
    if (!existsSync(base)) return [];
    const ids = (await readdir(base)).filter((d) => /^v\d{4}$/.test(d)).sort();
    return Promise.all(ids.map((id) => readJson<VersionMeta>(join(base, id, "meta.json"))));
  }

  async get(id: string): Promise<VersionMeta> {
    const path = join(this.dir(id as VersionId), "meta.json");
    if (!existsSync(path)) throw new BveError("NOT_FOUND", `Version ${id} does not exist`, { hint: "Run `bve version list`." });
    return readJson<VersionMeta>(path);
  }

  private async hashWorkingDocs(): Promise<Partial<Record<DocKey, string>>> {
    const out: Partial<Record<DocKey, string>> = {};
    for (const key of VERSIONED_DOCS) {
      const p = join(this.root, DOC_SPECS[key].path);
      if (existsSync(p)) out[key] = await sha256File(p);
    }
    return out;
  }

  async commit(head: VersionId | null, input: CommitInput, restores?: VersionId): Promise<VersionMeta> {
    const all = await this.list();
    const id = pad(all.length + 1);
    const docs = await this.hashWorkingDocs();
    const prev = head ? all.find((v) => v.id === head) : undefined;
    const changed = VERSIONED_DOCS.filter((k) => docs[k] !== prev?.docs[k]);
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    for (const key of Object.keys(docs) as DocKey[]) {
      const dest = join(dir, DOC_SPECS[key].path);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(join(this.root, DOC_SPECS[key].path), dest);
    }
    const meta: VersionMeta = {
      id,
      parent: head,
      ...(restores ? { restores } : {}),
      createdAt: new Date().toISOString(),
      actor: input.actor ?? "claude",
      command: input.command,
      message: input.message,
      changed,
      docs,
    };
    await writeJsonAtomic(join(dir, "meta.json"), meta);
    return meta;
  }

  /** Copy a version's documents into the working copy (removing docs that did not exist then). */
  async restoreInto(id: VersionId): Promise<DocKey[]> {
    const meta = await this.get(id);
    const present: DocKey[] = [];
    for (const key of VERSIONED_DOCS) {
      const working = join(this.root, DOC_SPECS[key].path);
      if (meta.docs[key]) {
        await mkdir(dirname(working), { recursive: true });
        await copyFile(join(this.dir(id), DOC_SPECS[key].path), working);
        present.push(key);
      } else if (existsSync(working)) {
        await rm(working);
      }
    }
    return present;
  }

  /** The state an undo should step back from: a restoring version stands for the state it restored. */
  async undoTarget(head: VersionId): Promise<VersionId> {
    const headMeta = await this.get(head);
    const logical = headMeta.restores ? await this.get(headMeta.restores) : headMeta;
    if (!logical.parent) throw new BveError("NOTHING_TO_UNDO", "Already at the initial version; nothing to undo");
    return logical.parent;
  }

  async diff(a: VersionId, b: VersionId): Promise<{ doc: DocKey; change: "added" | "removed" | "modified" }[]> {
    const [ma, mb] = await Promise.all([this.get(a), this.get(b)]);
    const out: { doc: DocKey; change: "added" | "removed" | "modified" }[] = [];
    for (const key of VERSIONED_DOCS) {
      const ha = ma.docs[key];
      const hb = mb.docs[key];
      if (ha === hb) continue;
      out.push({ doc: key, change: !ha ? "added" : !hb ? "removed" : "modified" });
    }
    return out;
  }
}
