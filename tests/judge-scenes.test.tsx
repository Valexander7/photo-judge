import React from "react"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import Judge from "../tabs/judge"
import { APP_ID } from "../lib/types"

const mocks = vi.hoisted(() => ({ compare: vi.fn(), send: vi.fn(), listeners: [] as ((message: unknown, sender: unknown) => void)[] }))
vi.mock("../lib/memory-judge", async (original) => ({
  ...await original<typeof import("../lib/memory-judge")>(),
  modelStatus: async () => "available",
  loadJudgments: async () => ({ a: { score: 5, people: true, reason: "Best" }, b: { score: 4, people: true, reason: "Similar" } }),
  saveJudgments: async () => {}
}))
vi.mock("../lib/scene-judge", async (original) => ({
  ...await original<typeof import("../lib/scene-judge")>(), compareMoments: mocks.compare
}))
vi.mock("../components/useBlobUrl", () => ({ useBlobUrl: () => ({ blobUrl: undefined }) }))
vi.mock("../components/JudgeViewer", () => ({ JudgeViewer: ({ index }: { index: number | null }) => <div data-testid="viewer">{index}</div> }))

afterEach(() => vi.unstubAllGlobals())
it("runs comparisons on request after cached ratings, links the keeper, and preserves manual choices on rerun", async () => {
  mocks.compare.mockResolvedValue({ flagged: new Set(["b"]), repeats: { b: { keeper: "a", reason: "Same moment" } }, done: 1, total: 1, failed: 0, stopped: false })
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} })
  vi.stubGlobal("chrome", { runtime: {
    sendMessage: mocks.send, getURL: (path: string) => path,
    onMessage: { addListener: (fn: (m: unknown, s: unknown) => void) => mocks.listeners.push(fn), removeListener: vi.fn() }
  } })
  const view = render(<Judge />)
  await act(async () => {
    mocks.listeners.forEach((fn) => fn({ app: APP_ID, action: "healthCheck.result", success: true, hasGptk: true }, {}))
  })
  fireEvent.click(screen.getByRole("button", { name: "Review these photos" }))
  const request = mocks.send.mock.calls.map(([m]) => m).find((m) => m.command === "getAllMediaItems")
  expect(request).toBeTruthy()
  await act(async () => {
    mocks.listeners.forEach((fn) => fn({ app: APP_ID, action: "gptkResultChunk", requestId: request.requestId, chunkIndex: 0, totalChunks: 1,
      data: ["a", "b"].map((key, i) => ({ mediaKey: key, dedupKey: key, thumb: "", timestamp: new Date("2026-06-12T12:00:00").getTime() + i * 60000 })) }, {}))
  })
  // Scene comparison no longer runs by itself (it is the heaviest GPU step).
  await screen.findByText("This batch: 0 to delete · 0 more waiting")
  expect(mocks.compare).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Compare repeated shots" }))
  await screen.findByText("This batch: 1 to delete · 0 more waiting")
  fireEvent.click(screen.getByRole("button", { name: "View suggested keeper" }))
  expect(screen.getByTestId("viewer")).toHaveTextContent("0")
  fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }))
  await screen.findByText("This batch: 0 to delete · 0 more waiting")
  fireEvent.click(screen.getByRole("button", { name: "Compare repeated shots" }))
  await waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2))
  await screen.findByText("This batch: 0 to delete · 0 more waiting")
  expect(mocks.send.mock.calls.some(([m]) => m.command === "trashItems")).toBe(false)
  view.unmount()
})
