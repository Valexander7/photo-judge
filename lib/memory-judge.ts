// Memory judge: rates how much each photo is likely to matter as a memory,
// using Chrome's built-in on-device model (Gemini Nano via the Prompt API).
// Nothing leaves the computer and there is no API key or cost.

import { buildThumbUrl } from "./photo-url"
import type { GpdMediaItem } from "./types"

export interface Judgment {
  score: number // 1 (no memory value) .. 5 (treasured moment)
  people: boolean
  blurry: boolean
  caption: string
  reason: string
}

export interface Moment {
  id: string
  items: GpdMediaItem[]
}

// A new moment starts when there is a gap longer than this between shots.
const MOMENT_GAP_MS = 30 * 60 * 1000
const THUMB_HEIGHT = 512
const CACHE_KEY = "memoryJudgments"

const SYSTEM_PROMPT = `You help someone clean up their personal photo library.
For each photo, rate how likely it is to matter as a memory years from now.
5 = people together, a clear special moment, or a photo they would frame.
4 = a good photo of a place, meal or scene that tells the story of the day.
3 = ordinary but fine, somewhat useful to remember the trip.
2 = filler with no story: random street, sign, menu, receipt, ceiling, repeat of nothing.
1 = accidental, pocket shot, very blurry, black, or a screenshot.
Answer only with the requested JSON. caption and reason: under 10 words each.`

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    people: { type: "boolean" },
    blurry: { type: "boolean" },
    caption: { type: "string" },
    reason: { type: "string" }
  },
  required: ["score", "people", "blurry", "caption", "reason"]
}

// The Prompt API is newer than our @types, so type the parts we use.
export interface LMSession {
  prompt(input: unknown, options?: unknown): Promise<string>
  clone(): Promise<LMSession>
  destroy(): void
}
interface LMStatic {
  availability(options?: unknown): Promise<string>
  create(options?: unknown): Promise<LMSession>
}
function getLM(): LMStatic | undefined {
  return (globalThis as unknown as { LanguageModel?: LMStatic }).LanguageModel
}

const MODEL_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
}

/** "available" | "downloadable" | "downloading" | "unavailable" | "missing" */
export async function modelStatus(): Promise<string> {
  const LM = getLM()
  if (!LM) return "missing"
  try {
    return await LM.availability(MODEL_OPTIONS)
  } catch {
    return "unavailable"
  }
}

/** Must be called from a click (Chrome requires it when the model downloads). */
export async function createJudgeSession(
  onDownload?: (fraction: number) => void,
  systemPrompt = SYSTEM_PROMPT
): Promise<LMSession> {
  const LM = getLM()
  if (!LM) throw new Error("Chrome's built-in AI is not available in this browser.")
  return LM.create({
    ...MODEL_OPTIONS,
    initialPrompts: [{ role: "system", content: systemPrompt }],
    monitor(m: EventTarget) {
      m.addEventListener("downloadprogress", (e) =>
        onDownload?.((e as ProgressEvent).loaded)
      )
    }
  })
}

export async function judgePhoto(
  base: LMSession,
  item: GpdMediaItem,
  signal?: AbortSignal
): Promise<Judgment> {
  const resp = await fetch(buildThumbUrl(item.thumb, { height: THUMB_HEIGHT }), {
    credentials: "include",
    signal
  })
  if (!resp.ok) throw new Error(`Could not load photo (${resp.status})`)
  const image = await createImageBitmap(await resp.blob())

  // A fresh clone per photo keeps earlier photos from filling the context.
  const session = await base.clone()
  try {
    const raw = await session.prompt(
      [
        {
          role: "user",
          content: [
            { type: "text", value: "Rate this photo." },
            { type: "image", value: image }
          ]
        }
      ],
      { responseConstraint: RESPONSE_SCHEMA, signal }
    )
    const j = JSON.parse(raw) as Judgment
    j.score = Math.min(5, Math.max(1, Math.round(j.score)))
    return j
  } finally {
    session.destroy()
    image.close()
  }
}

/** Sort by time taken and split wherever there is a long gap between shots. */
export function groupIntoMoments(items: GpdMediaItem[]): Moment[] {
  const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp)
  const moments: Moment[] = []
  for (const item of sorted) {
    const last = moments[moments.length - 1]
    const prev = last?.items[last.items.length - 1]
    if (!last || item.timestamp - prev.timestamp > MOMENT_GAP_MS) {
      moments.push({ id: item.mediaKey, items: [item] })
    } else {
      last.items.push(item)
    }
  }
  return moments
}

/**
 * Decide which photos in a moment to suggest deleting. Strict by design:
 * the best shots of every moment always stay, photos with people stay unless
 * they are clearly bad, and only low-value filler is flagged.
 */
export function suggestDeletes(
  moment: Moment,
  judgments: Record<string, Judgment>
): Set<string> {
  const judged = moment.items.filter((i) => judgments[i.mediaKey])
  const ranked = [...judged].sort(
    (a, b) => judgments[b.mediaKey].score - judgments[a.mediaKey].score
  )
  const keepCount = Math.max(1, Math.ceil(ranked.length * 0.2))
  const flagged = new Set<string>()
  ranked.forEach((item, rank) => {
    const j = judgments[item.mediaKey]
    // The best shots of a moment are protected, but only if they have some
    // memory value. A moment that is all receipts or signs has nothing to protect.
    if (rank < keepCount && j.score >= 3) return
    if (j.score <= 2 || (j.score === 3 && !j.people && j.blurry)) {
      flagged.add(item.mediaKey)
    }
  })
  return flagged
}

export async function loadJudgments(): Promise<Record<string, Judgment>> {
  const stored = await chrome.storage.local.get(CACHE_KEY)
  return (stored[CACHE_KEY] as Record<string, Judgment>) ?? {}
}

export async function saveJudgments(j: Record<string, Judgment>): Promise<void> {
  await chrome.storage.local.set({ [CACHE_KEY]: j })
}
