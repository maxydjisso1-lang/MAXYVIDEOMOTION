/**
 * How often do Whisper segment boundaries fall inside a sentence? (chantier 1)
 * A boundary is "mid-sentence" when the segment before it does not end with . ! ? … or a closing quote
 * after such a mark. Usage: tsx scripts/analyze-segmentation.ts <transcript.json>...
 */
import { readJson, type Transcript } from "../engine/core/src/index.js";

const END = /[.!?…]["»”)]*$/;
let total = 0;
let mid = 0;
for (const file of process.argv.slice(2)) {
  const t = await readJson<Transcript>(file);
  for (const s of t.sources) {
    const segs = s.segments;
    const boundaries = segs.slice(0, -1).map((seg, i) => ({ at: seg.end, tail: seg.text.trim().split(/\s+/).slice(-3).join(" "), head: segs[i + 1]!.text.trim().split(/\s+/).slice(0, 3).join(" "), mid: !END.test(seg.text.trim()) }));
    const m = boundaries.filter((b) => b.mid);
    total += boundaries.length;
    mid += m.length;
    console.log(`${file.replace(/\\/g, "/").split("/").slice(-3, -2)[0]}: ${segs.length} segments, ${m.length}/${boundaries.length} boundaries mid-sentence`);
    for (const b of m.slice(0, 4)) console.log(`   ${b.at.toFixed(2)}s  "…${b.tail}" | "${b.head}…"`);
  }
}
console.log(`\nTOTAL: ${mid}/${total} boundaries mid-sentence (${total ? ((mid / total) * 100).toFixed(0) : 0} %)`);
