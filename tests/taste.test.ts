import { describe, expect, it } from "vitest"

import { buildModel, certainty, decode, encode, tasteLean } from "../lib/taste"
import type { TasteExample } from "../lib/taste"

const vec = (a: number, b: number) => { const n = Math.hypot(a, b); return new Float32Array([a / n, b / n]) }
const ex = (v: Float32Array, deleted: boolean): TasteExample => ({ e: encode(v), v: deleted ? 1 : -1, t: 0 })

describe("taste memory", () => {
  it("round-trips fingerprints", () => {
    expect([...decode(encode(vec(3, 4)))]).toEqual([...vec(3, 4)])
  })
  it("leans toward keep for photos like ones John kept", () => {
    const model = buildModel([ex(vec(1, 0), false), ex(vec(1, 0.05), false), ex(vec(0, 1), true)])
    const r = tasteLean(vec(1, 0.02), model)
    expect(r.n).toBe(2)
    expect(r.lean).toBeCloseTo(-1)
    expect(tasteLean(vec(-1, 0), model).n).toBe(0) // nothing similar: no opinion
  })
  it("orders obvious junk before look-alikes and keeps certainty in range", () => {
    const j = (score: number) => ({ score, people: false, blurry: false, caption: "", reason: "" })
    expect(certainty(j(1), false, 0)).toBeGreaterThan(certainty(j(4), true, 0))
    expect(certainty(j(1), false, 1)).toBe(1)
  })
})
