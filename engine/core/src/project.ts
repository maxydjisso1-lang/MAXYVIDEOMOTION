import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BveError } from "./errors.js";
import { existsSync, readJson, sha256File, writeJsonAtomic } from "./fsutil.js";
import { DOC_SPECS, type DocKey, type Docs } from "./docs.js";
import { ENGINE_VERSION, PRESETS_DIR, SCHEMA_VERSION } from "./locations.js";
import { assertWritable, resolveInProject, slugId } from "./paths.js";
import { validate } from "./validate.js";
import { VersionStore, type CommitInput, type VersionId, type VersionMeta } from "./versions.js";
import type { Asset, Preset, ProjectManifest, Source } from "./types.generated.js";
import { silentLogger, type Logger } from "./log.js";

export type Target = ProjectManifest["targets"][number];

const PROJECT_DIRS = ["source", "assets", "analysis", "brand", "plan", "timeline", "color", "audio", "subtitles", "motion", "renders", "exports", "versions", "logs", ".cache"];

export class Project {
  readonly versions: VersionStore;

  private constructor(
    readonly root: string,
    public manifest: ProjectManifest,
    readonly log: Logger,
  ) {
    this.versions = new VersionStore(root);
  }

  static manifestPath(root: string) {
    return join(root, "project.json");
  }

  static async init(dir: string, name: string, log: Logger = silentLogger): Promise<Project> {
    const root = resolve(dir);
    if (existsSync(Project.manifestPath(root))) {
      throw new BveError("PROJECT_EXISTS", `A project already exists at ${root}`, { hint: "Use --project to target it, or choose another directory." });
    }
    for (const d of PROJECT_DIRS) await mkdir(join(root, d), { recursive: true });
    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      schemaVersion: SCHEMA_VERSION,
      id: slugId(name, "p_"),
      name,
      createdAt: now,
      updatedAt: now,
      engineVersion: ENGINE_VERSION,
      sources: [],
      assets: [],
      documents: {},
      targets: [],
      versioning: { head: "v0000", autoCommit: true },
      exports: [],
    };
    const project = new Project(root, manifest, log);
    const meta = await project.versions.commit(null, { actor: "engine", command: "init", message: `Project "${name}" created` });
    project.manifest.versioning.head = meta.id;
    await project.saveManifest();
    return project;
  }

  static async open(dir: string, log: Logger = silentLogger): Promise<Project> {
    const root = resolve(dir);
    const path = Project.manifestPath(root);
    if (!existsSync(path)) {
      throw new BveError("NOT_FOUND", `No project.json in ${root}`, { hint: "Run `bve init <dir>` first, or pass --project <dir>." });
    }
    const manifest = validate<ProjectManifest>("project", await readJson(path), "project.json");
    return new Project(root, manifest, log);
  }

  async saveManifest(): Promise<void> {
    this.manifest.updatedAt = new Date().toISOString();
    validate("project", this.manifest, "project.json");
    await writeJsonAtomic(Project.manifestPath(this.root), this.manifest);
  }

  get head(): VersionId {
    return this.manifest.versioning.head as VersionId;
  }

  abs(rel: string): string {
    return resolveInProject(this.root, rel);
  }

  writable(rel: string): string {
    return assertWritable(this.root, rel);
  }

  // ---------------------------------------------------------------- documents

  docPath(key: DocKey): string {
    return join(this.root, DOC_SPECS[key].path);
  }

  hasDoc(key: DocKey): boolean {
    return existsSync(this.docPath(key));
  }

  async readDoc<K extends DocKey>(key: K): Promise<Docs[K]> {
    if (!this.hasDoc(key)) {
      throw new BveError("MISSING_INPUT", `Document "${key}" does not exist yet (${DOC_SPECS[key].path})`, { hint: hintFor(key) });
    }
    return validate<Docs[K]>(DOC_SPECS[key].schema, await readJson(this.docPath(key)), DOC_SPECS[key].path);
  }

  async readDocOptional<K extends DocKey>(key: K): Promise<Docs[K] | undefined> {
    return this.hasDoc(key) ? this.readDoc(key) : undefined;
  }

  /** Validate → atomic write → register → auto-commit a version (for decision documents). */
  async writeDocs(docs: Partial<Docs>, commit: CommitInput): Promise<VersionMeta | undefined> {
    const keys = Object.keys(docs) as DocKey[];
    for (const key of keys) validate(DOC_SPECS[key].schema, docs[key], DOC_SPECS[key].path);
    for (const key of keys) {
      await writeJsonAtomic(assertWritable(this.root, DOC_SPECS[key].path), docs[key]);
      this.manifest.documents[key] = DOC_SPECS[key].path;
    }
    let meta: VersionMeta | undefined;
    if (this.manifest.versioning.autoCommit !== false && keys.some((k) => DOC_SPECS[k].versioned)) {
      meta = await this.versions.commit(this.head, commit);
      this.manifest.versioning.head = meta.id;
    }
    await this.saveManifest();
    return meta;
  }

  async writeDoc<K extends DocKey>(key: K, doc: Docs[K], commit: CommitInput): Promise<VersionMeta | undefined> {
    return this.writeDocs({ [key]: doc } as Partial<Docs>, commit);
  }

  // ---------------------------------------------------------------- versions

  async undo(): Promise<VersionMeta> {
    const target = await this.versions.undoTarget(this.head);
    return this.restore(target, "undo", `Undo: restored state of ${target}`);
  }

  async checkout(id: VersionId): Promise<VersionMeta> {
    await this.versions.get(id);
    return this.restore(id, "checkout", `Checkout: restored state of ${id}`);
  }

  private async restore(target: VersionId, command: string, message: string): Promise<VersionMeta> {
    const present = await this.versions.restoreInto(target);
    for (const key of Object.keys(DOC_SPECS) as DocKey[]) {
      if (!DOC_SPECS[key].versioned) continue;
      if (present.includes(key)) this.manifest.documents[key] = DOC_SPECS[key].path;
      else delete this.manifest.documents[key];
    }
    const meta = await this.versions.commit(this.head, { actor: "claude", command, message }, target);
    this.manifest.versioning.head = meta.id;
    await this.saveManifest();
    return meta;
  }

  // ---------------------------------------------------------------- sources, assets, targets

  source(id: string): Source {
    const s = this.manifest.sources.find((x) => x.id === id);
    if (!s) throw new BveError("NOT_FOUND", `Unknown source "${id}"`, { hint: `Known: ${this.manifest.sources.map((x) => x.id).join(", ") || "none"}` });
    return s;
  }

  /** Path the engine should decode for a source: the CFR mezzanine when one exists. */
  sourceMediaPath(id: string): string {
    const s = this.source(id);
    return this.abs(s.mezzanine ?? s.path);
  }

  asset(id: string): Asset {
    const a = (this.manifest.assets ?? []).find((x) => x.id === id);
    if (!a) throw new BveError("NOT_FOUND", `Unknown asset "${id}"`);
    return a;
  }

  target(id: string): Target {
    const t = this.manifest.targets.find((x) => x.id === id);
    if (!t) {
      throw new BveError("NOT_FOUND", `Unknown target "${id}"`, { hint: `Add it with \`bve target add ${id} --preset instagram/reels\`. Known: ${this.manifest.targets.map((x) => x.id).join(", ") || "none"}` });
    }
    return t;
  }

  async preset(targetId: string): Promise<Preset> {
    const t = this.target(targetId);
    const base = await loadPreset(t.preset);
    return validate<Preset>("preset", { ...base, ...(t.overrides ?? {}) }, `preset ${t.preset}`);
  }

  /** Add or replace a delivery target (validated against the preset catalogue). */
  async addTarget(id: string, presetId: string): Promise<Target[]> {
    await loadPreset(presetId);
    this.manifest.targets = [...this.manifest.targets.filter((t) => t.id !== id), { id, preset: presetId }];
    await this.saveManifest();
    return this.manifest.targets;
  }

  /** Frame rate the documents are authored for: the first target's, else 30. */
  async deliveryFps(): Promise<number> {
    const first = this.manifest.targets[0];
    return first ? (await this.preset(first.id)).fps : 30;
  }

  /** Delete disposable artifacts. Sources, documents, versions and exports are never touched. */
  async clean(): Promise<string[]> {
    const removed: string[] = [];
    for (const rel of [".cache", "renders/cache", "renders/frames"]) {
      if (existsSync(this.abs(rel))) {
        await rm(this.abs(rel), { recursive: true, force: true });
        removed.push(rel);
      }
    }
    return removed;
  }

  /** Re-hash every source: any change after ingest breaks reproducibility and must stop the pipeline. */
  async verifySources(): Promise<{ id: string; ok: boolean; reason?: string }[]> {
    const out = [];
    for (const s of this.manifest.sources) {
      const p = this.abs(s.path);
      if (!existsSync(p)) out.push({ id: s.id, ok: false, reason: "missing" });
      else if ((await sha256File(p)) !== s.sha256) out.push({ id: s.id, ok: false, reason: "modified since ingest" });
      else out.push({ id: s.id, ok: true });
    }
    return out;
  }
}

export async function loadPreset(id: string): Promise<Preset> {
  const [platform, name] = id.split("/");
  const path = join(PRESETS_DIR, platform ?? "", `${name}.json`);
  if (!platform || !name || !existsSync(path)) {
    throw new BveError("NOT_FOUND", `Unknown preset "${id}"`, { hint: "See presets/ (e.g. instagram/reels, tiktok/vertical, youtube/landscape)." });
  }
  return validate<Preset>("preset", await readJson(path), `preset ${id}`);
}

function hintFor(key: DocKey): string {
  const hints: Record<DocKey, string> = {
    brand: "Create it with the brand-intelligence skill (`bve brand set <brand.json>`).",
    styleTokens: "Run `bve brand tokens`.",
    analysis: "Run `bve analyze`.",
    transcript: "Run `bve analyze --transcribe` or `bve transcript import <file>`.",
    plan: "Write it with the creative-director skill (`bve plan set <file>`).",
    timeline: "Run `bve plan compile`.",
    color: "Run `bve color auto`.",
    audio: "Run `bve audio clean`.",
    captions: "Run `bve captions build`.",
    motion: "Run `bve motion from-plan`.",
  };
  return hints[key];
}
