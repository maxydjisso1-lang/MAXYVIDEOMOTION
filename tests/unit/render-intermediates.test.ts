import { describe, expect, it } from "vitest";
import { intermediateEncode } from "../../engine/rendering/src/basePlate.js";

describe("render intermediates (chantier 6)", () => {
  it("final renders use lossless, fast intermediates; only the delivery encode compresses", () => {
    expect(intermediateEncode(false)).toEqual(["-preset", "ultrafast", "-qp", "0"]);
  });
  it("drafts keep their previous settings", () => {
    expect(intermediateEncode(true)).toEqual(["-preset", "veryfast", "-crf", "22"]);
  });
});
