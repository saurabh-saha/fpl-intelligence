import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "@/lib/share";

const ids = Array.from({ length: 15 }, (_, i) => 100 + i);

describe("share links", () => {
  it("round-trips a squad including unicode names", () => {
    const d = encodeShare({ gw: 11, ids, captain: 100, vice: 101, name: "Sauräbh's Dream XI ⚽", mode: "safe" });
    expect(d).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(d)).toEqual({ gw: 11, ids, captain: 100, vice: 101, name: "Sauräbh's Dream XI ⚽", mode: "safe" });
  });
  it("rejects garbage and wrong sizes", () => {
    expect(decodeShare("not-base64!!")).toBeNull();
    expect(decodeShare(encodeShare({ gw: 1, ids: ids.slice(1), captain: 1, vice: 2 }))).toBeNull();
  });
});
