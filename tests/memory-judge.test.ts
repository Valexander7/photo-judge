import { describe, expect, it } from "vitest"

import { groupIntoMoments, suggestDeletes } from "../lib/memory-judge"
import type { Judgment } from "../lib/memory-judge"
import type { GpdMediaItem } from "../lib/types"

const MIN = 60 * 1000
const item = (key: string, t: number) =>
  ({ mediaKey: key, dedupKey: key, thumb: "", timestamp: t, creationTimestamp: t }) as GpdMediaItem
const j = (score: number, people = false, blurry = false): Judgment =>
  ({ score, people, blurry, caption: "", reason: "" })

describe("groupIntoMoments", () => {
  it("splits on gaps over 30 minutes", () => {
    const m = groupIntoMoments([item("c", 100 * MIN), item("a", 0), item("b", 10 * MIN)])
    expect(m.map((x) => x.items.map((i) => i.mediaKey))).toEqual([["a", "b"], ["c"]])
  })
})

describe("suggestDeletes", () => {
  it("protects the best shot only when it has memory value", () => {
    const m = groupIntoMoments([item("a", 0), item("b", MIN)])
    expect([...suggestDeletes(m[0], { a: j(3), b: j(1) })]).toEqual(["b"])
    expect([...suggestDeletes(m[0], { a: j(2), b: j(1) })].sort()).toEqual(["a", "b"])
  })
  it("keeps ordinary photos with people, flags filler", () => {
    const m = groupIntoMoments([0, 1, 2, 3, 4].map((n) => item(`p${n}`, n * MIN)))
    const flags = suggestDeletes(m[0], {
      p0: j(5, true), p1: j(3, true, true), p2: j(2), p3: j(3, false, true), p4: j(4)
    })
    expect([...flags].sort()).toEqual(["p2", "p3"])
  })
})

import { findLookalikes } from "../lib/lookalikes"

describe("findLookalikes", () => {
  const vec = (a: number, b: number) => { const n = Math.hypot(a, b); return new Float32Array([a / n, b / n]) }
  it("keeps the sharpest of a series and leaves different scenes alone", () => {
    const items = [0, 1, 2, 3].map((n) => item(`s${n}`, n * 5000))
    const m = groupIntoMoments(items)
    const prints = {
      s0: { embedding: vec(1, 0), sharpness: 10 },
      s1: { embedding: vec(1, 0.05), sharpness: 50 },
      s2: { embedding: vec(1, 0.02), sharpness: 20 },
      s3: { embedding: vec(0, 1), sharpness: 5 }
    }
    const js = { s0: j(5, true), s1: j(5, true), s2: j(5, true), s3: j(5, true) }
    const g = findLookalikes(m, prints, js, 0.9)
    expect(g).toEqual([{ keepers: ["s1"], extras: ["s2", "s0"] }])
  })
})
