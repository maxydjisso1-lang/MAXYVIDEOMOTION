/**
 * Brand fonts: rendering must never depend silently on fonts installed on the machine.
 * A role's font is FOUND (brand file present), FALLBACK (declared fallback file present) or
 * MISSING (neither: the renderer would use a system font — QC blocks this).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { BveError, existsSync, type Brand, type Project, type StyleTokens } from "../../core/src/index.js";
import { readFontFile } from "./fontfile.js";

export type FontRole = "display" | "body" | "caption";
export type FontStatus = "found" | "fallback" | "missing";

export interface RoleFont {
  role: FontRole;
  requested: string;
  weight: number;
  status: FontStatus;
  used: string;
  /** Files the renderers must load, per family. */
  faces: { family: string; weight: number; path: string }[];
  detail: string;
}

export type BrandFontsReport = { roles: RoleFont[]; fetched: string[] };

/**
 * What a legacy-name matcher (libass) must ask for to get the right file for this role:
 * the file closest to the requested weight, addressed by its OWN family name and bold flag.
 */
export function legacyFaceFor(project: Project, role: RoleFont): { fontname: string; bold: boolean; postscript: string } | undefined {
  const files = role.faces.map((f) => ({ ...f, info: readFontFile(project.abs(f.path)) })).filter((f) => f.info.family);
  if (!files.length) return undefined;
  const best = files.sort((a, b) => Math.abs(a.info.weight - role.weight) - Math.abs(b.info.weight - role.weight))[0]!;
  return { fontname: best.info.family, bold: /bold/i.test(best.info.subfamily), postscript: best.info.postscript };
}

const ROLES: FontRole[] = ["display", "body", "caption"];

/** Weight each role actually renders with (captions carry their own weight in the tokens). */
export const roleWeight = (t: StyleTokens, role: FontRole) => (role === "caption" ? t.caption.weight : t.type[role].weight);

export function resolveFonts(project: Project, t: StyleTokens): RoleFont[] {
  return ROLES.map((role) => {
    const f = t.type[role];
    const weight = roleWeight(t, role);
    const own = (f.files ?? []).filter((x) => existsSync(project.abs(x.path)));
    const fb = (f.fallbackFiles ?? []).filter((x) => existsSync(project.abs(x.path)));
    const requested = `${f.family} ${weight}`;
    if (own.length) {
      const exact = own.some((x) => x.weight === weight);
      return { role, requested, weight, status: "found" as const, used: f.family, faces: own.map((x) => ({ family: f.family, ...x })), detail: exact ? "brand font file" : `brand font file (nearest weight: ${own.map((x) => x.weight).join("/")})` };
    }
    if (fb.length && f.fallback) {
      return { role, requested, weight, status: "fallback" as const, used: f.fallback, faces: fb.map((x) => ({ family: f.fallback!, ...x })), detail: `brand font file missing → declared fallback "${f.fallback}"` };
    }
    return { role, requested, weight, status: "missing" as const, used: "system default", faces: [], detail: `no font file for "${f.family}"${f.fallback ? ` nor its fallback "${f.fallback}"` : ""}: run \`bve brand fonts fetch\` or add the files to brand/fonts/` };
  });
}

/** Parse Google Fonts CSS (truetype flavour) into {weight, url} pairs. */
function parseCss(css: string): { weight: number; url: string }[] {
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].flatMap((m) => {
    const w = /font-weight:\s*(\d+)/.exec(m[1]!)?.[1];
    const u = /url\((https:[^)]+)\)/.exec(m[1]!)?.[1];
    return w && u ? [{ weight: Number(w), url: u }] : [];
  });
}

async function fetchFamily(family: string, weights: number[]): Promise<{ weight: number; bytes: Buffer }[]> {
  const out: { weight: number; bytes: Buffer }[] = [];
  for (const w of [...new Set(weights)]) {
    // An old user agent makes the API return plain TrueType files (portable to libass and Chrome).
    const get = (q: string) => fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}${q}`, { headers: { "User-Agent": "Mozilla/4.0" } });
    let res = await get(`:wght@${w}`);
    if (!res.ok) res = await get(""); // single-weight families (e.g. Anton) reject weight queries
    if (!res.ok) throw new BveError("NOT_FOUND", `Google Fonts has no family "${family}" (HTTP ${res.status})`, { hint: "Check the spelling, or add the font files to brand/fonts/ yourself." });
    for (const face of parseCss(await res.text())) {
      if (out.some((o) => o.weight === face.weight)) continue;
      const file = await fetch(face.url);
      if (!file.ok) throw new BveError("NOT_FOUND", `Could not download ${face.url} (HTTP ${file.status})`);
      out.push({ weight: face.weight, bytes: Buffer.from(await file.arrayBuffer()) });
    }
  }
  return out;
}

const fileName = (family: string, weight: number) => `brand/fonts/${family.replace(/[^A-Za-z0-9]+/g, "")}-${weight}.ttf`;

/**
 * Download, ONCE at setup time, the Google fonts the brand declares (and the fallbacks of
 * commercial fonts whose files are absent) into brand/fonts/, then point brand.json at the files.
 */
export async function fetchBrandFonts(project: Project): Promise<BrandFontsReport> {
  const brand = await project.readDoc("brand");
  const tokens = await project.readDoc("styleTokens");
  const next: Brand = structuredClone(brand);
  const fetched: string[] = [];
  await mkdir(project.abs("brand/fonts"), { recursive: true });
  const weightsFor = (family: string) =>
    ROLES.filter((r) => tokens.type[r].family === family || tokens.type[r].fallback === family).map((r) => roleWeight(tokens, r)).concat(brand.identity.fonts.find((f) => f.family === family)?.weights ?? []);

  for (const f of next.identity.fonts) {
    const ownFiles = (f.source?.kind === "file" ? (f.source.files?.map((x) => x.path) ?? [f.source.path]) : []).filter((p): p is string => !!p);
    const ownPresent = ownFiles.length > 0 && ownFiles.every((p) => existsSync(project.abs(p)));
    if (f.source?.kind === "google" || (!ownPresent && f.source?.kind !== "file")) {
      const faces = await fetchFamily(f.family, weightsFor(f.family));
      for (const face of faces) {
        await writeFile(project.writable(fileName(f.family, face.weight)), face.bytes);
        fetched.push(fileName(f.family, face.weight));
      }
      f.source = { kind: "file", files: faces.map((x) => ({ weight: x.weight, path: fileName(f.family, x.weight) })) };
      f.license ??= "OFL-1.1 or Apache-2.0 (Google Fonts)";
    } else if (!ownPresent && f.fallback) {
      const faces = await fetchFamily(f.fallback, weightsFor(f.fallback));
      for (const face of faces) {
        await writeFile(project.writable(fileName(f.fallback, face.weight)), face.bytes);
        fetched.push(fileName(f.fallback, face.weight));
      }
      f.fallbackSource = { kind: "file", files: faces.map((x) => ({ weight: x.weight, path: fileName(f.fallback!, x.weight) })) };
    }
  }
  const { compileStyleTokens } = await import("./tokens.js");
  const newTokens = compileStyleTokens(next, tokens.fps);
  await project.writeDocs({ brand: next, styleTokens: newTokens }, { command: "brand fonts fetch", message: `Fetched ${fetched.length} font file(s) into brand/fonts/` });
  return { roles: resolveFonts(project, newTokens), fetched };
}
