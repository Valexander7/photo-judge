import { afterEach, describe, expect, it, vi } from "vitest"
import { compareBatch, compareMoments, comparisonBatches, mergeSuggestions, validateSceneDecision } from "../lib/scene-judge"
import type { Judgment, LMSession, Moment } from "../lib/memory-judge"
import type { GpdMediaItem } from "../lib/types"

const item = (key: string, minute = 0) => ({ mediaKey: key, thumb: `https://example.test/${key}`, timestamp: minute * 60000 }) as GpdMediaItem
const judgment = (score: number): Judgment => ({ score, people: true, blurry: false, caption: "", reason: "" })
const moment = (...keys: string[]): Moment => ({ id: keys[0], items: keys.map((key, i) => item(key, i)) })
const scores = (keys: string[], score = 5) => Object.fromEntries(keys.map((key) => [key, judgment(score)]))
const proposal = (photo: string, keeper: string) => ({ photo, keeper, reason: "Same entrance; keeper has a clearer view." })
afterEach(() => vi.unstubAllGlobals())

describe("scene selection", () => {
  it("can remove high-scoring repeats with people while preserving distinct photos", () => {
    const result = mergeSuggestions([moment("selfie1", "selfie2", "entrance", "portrait")],
      scores(["selfie1", "selfie2", "entrance", "portrait"]), [proposal("selfie2", "selfie1")])
    expect([...result.flagged]).toEqual(["selfie2"])
    expect(result.repeats.selfie2.keeper).toBe("selfie1")
  })
  it("does not force a quota when every scene is distinct", () => {
    expect(mergeSuggestions([moment("a", "b", "c")], scores(["a", "b", "c"]), []).flagged.size).toBe(0)
  })
  it("unflags a low-rated keeper that baseline filler rules would delete", () => {
    const result = mergeSuggestions([moment("a", "b", "c")], { a: judgment(5), b: judgment(2), c: judgment(1) }, [proposal("c", "b")])
    expect(result.flagged.has("b")).toBe(false)
    expect(result.flagged.has("c")).toBe(true)
  })
  it("prevents chains and cycles from overlapping comparisons", () => {
    const result = mergeSuggestions([moment("a", "b", "c", "d")], scores(["a", "b", "c", "d"]),
      [proposal("b", "a"), proposal("a", "c"), proposal("c", "b"), proposal("d", "a")])
    expect([...result.flagged].sort()).toEqual(["b", "d"])
    for (const r of Object.values(result.repeats)) expect(result.flagged.has(r.keeper)).toBe(false)
  })
  it("ignores unknown or unjudged identities", () => {
    const result = mergeSuggestions([moment("a", "b", "c")], scores(["a", "b"]), [proposal("a", "missing"), proposal("c", "b")])
    expect(result.flagged.size).toBe(0)
  })
  it("covers long moments with bounded overlap and does not cross moments", () => {
    const keys = Array.from({ length: 17 }, (_, i) => String(i))
    const batches = comparisonBatches([moment(...keys), moment("other")], scores([...keys, "other"]))
    expect(batches.map((b) => b.length)).toEqual([8, 8, 5])
    expect(batches[1][0].mediaKey).toBe("6")
    expect(new Set(batches.flat().map((i) => i.mediaKey))).toEqual(new Set(keys))
  })
})

describe("comparison response validation", () => {
  it("accepts a complete selection or all unique keepers", () => {
    expect(validateSceneDecision({ keep: [1], repeats: [{ photo: 2, keeper: 1, reason: "Same moment" }] }, 2).keep).toEqual([1])
    expect(validateSceneDecision({ keep: [1, 2], repeats: [] }, 2).repeats).toEqual([])
  })
  it.each([
    { keep: [1], repeats: [] },
    { keep: [1, 1], repeats: [] },
    { keep: [1], repeats: [{ photo: 1, keeper: 1, reason: "x" }] },
    { keep: [1], repeats: [{ photo: 2, keeper: 2, reason: "x" }] },
    { keep: [1], repeats: [{ photo: 3, keeper: 1, reason: "x" }] },
    { keep: [1], repeats: [{ photo: 2, keeper: 1, reason: "" }] },
    { keep: [], repeats: [] }, null
  ])("rejects incomplete or conflicting output %j", (output) => {
    expect(() => validateSceneDecision(output, 2)).toThrow()
  })
})

function mockRuntime(raw = '{"keep":[1],"repeats":[{"photo":2,"keeper":1,"reason":"Same scene, sharper keeper"}]}') {
  const stored: Record<string, unknown> = {}
  const child = { prompt: vi.fn().mockResolvedValue(raw), destroy: vi.fn(), clone: vi.fn() }
  const base = { prompt: vi.fn(), clone: vi.fn().mockResolvedValue(child), destroy: vi.fn() }
  const create = vi.fn().mockResolvedValue(base)
  const close = vi.fn()
  vi.stubGlobal("LanguageModel", { create })
  vi.stubGlobal("chrome", { storage: { local: {
    get: vi.fn(async () => stored), set: vi.fn(async (data) => Object.assign(stored, data))
  } } })
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() }))
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ close }))
  return { base, child, create, close }
}

describe("comparison lifecycle", () => {
  it("sends the actual images together, then reuses versioned comparison results", async () => {
    const mock = mockRuntime()
    const ms = [moment("a", "b")], js = scores(["a", "b"])
    const first = await compareMoments(ms, js, new AbortController().signal, vi.fn())
    expect([...first.flagged]).toEqual(["b"])
    expect(mock.child.prompt.mock.calls[0][0][0].content.filter((c: { type: string }) => c.type === "image")).toHaveLength(2)
    expect(mock.close).toHaveBeenCalledTimes(2)
    expect(mock.base.destroy).toHaveBeenCalledOnce()
    const second = await compareMoments(ms, js, new AbortController().signal, vi.fn())
    expect([...second.flagged]).toEqual(["b"])
    expect(mock.create).toHaveBeenCalledOnce()
  })
  it("adds no repeat suggestions on malformed model output", async () => {
    const mock = mockRuntime('{"keep":[1],"repeats":[]}')
    const result = await compareMoments([moment("a", "b")], scores(["a", "b"]), new AbortController().signal, vi.fn())
    expect(result.failed).toBe(1)
    expect(result.flagged.size).toBe(0)
    expect(mock.child.destroy).toHaveBeenCalledOnce()
  })
  it("releases already loaded images when a later download fails", async () => {
    const mock = mockRuntime()
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, blob: async () => new Blob() } as Response)
      .mockResolvedValueOnce({ ok: false, status: 403 } as Response)
    await expect(compareBatch(mock.base as LMSession, moment("a", "b").items, scores(["a", "b"]))).rejects.toThrow("403")
    expect(mock.close).toHaveBeenCalledOnce()
    expect(mock.base.clone).not.toHaveBeenCalled()
  })
  it("stops without treating an unfinished comparison as a decision", async () => {
    const mock = mockRuntime()
    const abort = new AbortController()
    mock.child.prompt.mockImplementationOnce(async () => { abort.abort(); throw new DOMException("Stopped", "AbortError") })
    const result = await compareMoments([moment("a", "b")], scores(["a", "b"]), abort.signal, vi.fn())
    expect(result.stopped).toBe(true)
    expect(result.flagged.size).toBe(0)
    expect(mock.child.destroy).toHaveBeenCalledOnce()
    expect(mock.base.destroy).toHaveBeenCalledOnce()
  })
})
