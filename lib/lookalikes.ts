// Look-alike grouping: finds runs of near-identical shots (same people, same
// spot, a few seconds apart) by comparing image fingerprints, not by asking
// the AI. The AI tends to rate every group photo 5/5, so it can't tell seven
// copies of the same pose apart. Fingerprints can, and they are deterministic.

import { computeEmbeddings, fetchThumbnails } from "./duplicate-detector"
import type { Moment } from "./memory-judge"
import type { Judgment } from "./memory-judge"
import type { GpdMediaItem } from "./types"

export interface Fingerprint {
  embedding: Float32Array
  sharpness: number
}

export interface LookalikeGroup {
  keepers: string[]
  extras: string[]
}

// Shots further apart than this are never treated as look-alikes, even if
// they look similar (e.g. the same landmark on two different days).
const MAX_GAP_MS = 3 * 60 * 1000

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot // embeddings are L2-normalized
}

/** Blur check: variance of a Laplacian filter over a small grayscale copy. */
async function sharpnessOf(blob: Blob): Promise<number> {
  const bmp = await createImageBitmap(blob)
  const w = 256
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const px = ctx.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
  let sum = 0, sumSq = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]
      sum += lap; sumSq += lap * lap; n++
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

export async function fingerprint(
  items: GpdMediaItem[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal
): Promise<Record<string, Fingerprint>> {
  const blobs = await fetchThumbnails(items, new Set(), (p) => onProgress?.(p.current, p.total * 2), signal)
  const keys = items.map((i) => i.mediaKey)
  const { embeddings, validIndices } = await computeEmbeddings(
    blobs, keys, null, new Set(), (p) => onProgress?.(p.total + p.current, p.total * 2), signal
  )
  const out: Record<string, Fingerprint> = {}
  for (let k = 0; k < validIndices.length; k++) {
    const idx = validIndices[k]
    const blob = blobs[idx]
    if (!blob) continue
    out[keys[idx]] = { embedding: embeddings[k], sharpness: await sharpnessOf(blob) }
  }
  return out
}

/**
 * Walk each moment in time order and chain a photo onto the current group
 * when it looks like the group's previous photo (similarity >= threshold)
 * and was taken soon after. Then keep the best one or two of every group.
 */
export function findLookalikes(
  moments: Moment[],
  prints: Record<string, Fingerprint>,
  judgments: Record<string, Judgment>,
  threshold: number
): LookalikeGroup[] {
  const groups: LookalikeGroup[] = []
  for (const m of moments) {
    let run: GpdMediaItem[] = []
    const flush = () => {
      if (run.length > 1) groups.push(pickKeepers(run, prints, judgments))
      run = []
    }
    for (const item of m.items) {
      const fp = prints[item.mediaKey]
      if (!fp) { flush(); continue }
      // Compare with the last few photos in the run so a slightly different
      // frame in the middle doesn't break an otherwise identical series.
      const similar = run.slice(-3).some((prev) =>
        item.timestamp - prev.timestamp <= MAX_GAP_MS &&
        cosine(fp.embedding, prints[prev.mediaKey].embedding) >= threshold)
      if (run.length && !similar) flush()
      run.push(item)
    }
    flush()
  }
  return groups
}

function pickKeepers(
  run: GpdMediaItem[],
  prints: Record<string, Fingerprint>,
  judgments: Record<string, Judgment>
): LookalikeGroup {
  // Best = highest memory score, then sharpest.
  const ranked = [...run].sort((a, b) =>
    (judgments[b.mediaKey]?.score ?? 0) - (judgments[a.mediaKey]?.score ?? 0) ||
    prints[b.mediaKey].sharpness - prints[a.mediaKey].sharpness)
  // A long series (6+) keeps two, in case one has someone's eyes closed.
  const keep = run.length >= 6 ? 2 : 1
  return {
    keepers: ranked.slice(0, keep).map((i) => i.mediaKey),
    extras: ranked.slice(keep).map((i) => i.mediaKey)
  }
}
