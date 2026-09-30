/**
 * Minimal OpenType/TrueType reader: the names and weight a font file really declares.
 * Needed because renderers match fonts differently: Chrome uses the FontFace we register,
 * libass uses the file's legacy family name (e.g. "Inter SemiBold", not "Inter" + 600).
 */
import { readFileSync } from "node:fs";

export interface FontFileInfo {
  /** nameID 1 — what libass/GDI match on. */
  family: string;
  /** nameID 2 — "Regular", "Bold", "Italic"… */
  subfamily: string;
  /** nameID 16 when present, else nameID 1. */
  typographicFamily: string;
  /** nameID 6 */
  postscript: string;
  /** OS/2 usWeightClass */
  weight: number;
  variable: boolean;
}

export function readFontFile(path: string): FontFileInfo {
  const b = readFileSync(path);
  const sig = b.toString("latin1", 0, 4);
  if (sig === "wOFF" || sig === "wOF2") {
    // Compressed web fonts: names are not readable without decompression; trust the declaration.
    return { family: "", subfamily: "", typographicFamily: "", postscript: "", weight: 0, variable: false };
  }
  const numTables = b.readUInt16BE(4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[b.toString("latin1", o, o + 4)] = b.readUInt32BE(o + 8);
  }
  const names: Record<number, string> = {};
  const nm = tables.name;
  if (nm !== undefined) {
    const count = b.readUInt16BE(nm + 2);
    const strings = nm + b.readUInt16BE(nm + 4);
    for (let i = 0; i < count; i++) {
      const r = nm + 6 + i * 12;
      const platform = b.readUInt16BE(r);
      const id = b.readUInt16BE(r + 6);
      const len = b.readUInt16BE(r + 8);
      const off = b.readUInt16BE(r + 10);
      if (platform !== 3 || names[id] !== undefined) continue; // Windows, UTF-16BE
      let s = "";
      for (let k = 0; k < len; k += 2) s += String.fromCharCode(b.readUInt16BE(strings + off + k));
      names[id] = s;
    }
  }
  const os2 = tables["OS/2"];
  return {
    family: names[1] ?? "",
    subfamily: names[2] ?? "Regular",
    typographicFamily: names[16] ?? names[1] ?? "",
    postscript: names[6] ?? "",
    weight: os2 !== undefined ? b.readUInt16BE(os2 + 4) : 400,
    variable: "fvar" in tables,
  };
}
