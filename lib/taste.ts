// Taste memory: learns John's likes and dislikes from what he actually does.
//
// Every time he moves a batch to trash, each photo he reviewed becomes an
// example: trashed = "delete", suggested-but-kept = "keep". Examples are image
// fingerprints, so later photos that look like ones he kept are left alone,
// and photos that look like ones he deleted are suggested with more certainty.
// Stored only in this browser (chrome.storage.local); nothing leaves the Mac.

import type { Judgment } from "./memory-judge"

export interface TasteExample {
  e: string // fingerprint, base64 Float32Array
  v: 1 | -1 // 1 = John deleted it, -1 = John kept it
  t: number // when he decided
  k?: string // photo it came from, so an undo can take it back
}

const KEY = "tasteMemory"
const MAX_EXAMPLES = 5000
// How alike a past decision must be to count as a hint for a new photo.
const NEIGHBOR_SIMILARITY = 0.8
const K = 5

export function encode(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function decode(s: string): Float32Array {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

export async function loadTaste(): Promise<TasteExample[]> {
  try {
    return ((await chrome.storage.local.get(KEY))[KEY] as TasteExample[]) ?? []
  } catch {
    return []
  }
}

export async function addTaste(
  prev: TasteExample[],
  decisions: Array<{ embedding: Float32Array; deleted: boolean; key?: string }>
): Promise<TasteExample[]> {
  const now = Date.now()
  const next = [
    ...prev,
    ...decisions.map((d) => ({ e: encode(d.embedding), v: (d.deleted ? 1 : -1) as 1 | -1, t: now, k: d.key }))
  ].slice(-MAX_EXAMPLES) // oldest decisions drop off first
  try {
    await chrome.storage.local.set({ [KEY]: next })
  } catch {
    // learning is a bonus; never block a trash on it
  }
  return next
}

/** Forget decisions from an undone batch. */
export async function removeTaste(prev: TasteExample[], keys: Set<string>): Promise<TasteExample[]> {
  const next = prev.filter((x) => !x.k || !keys.has(x.k))
  try {
    await chrome.storage.local.set({ [KEY]: next })
  } catch {
    // not critical
  }
  return next
}

export interface TasteModel {
  vectors: Float32Array[]
  votes: number[]
}

export function buildModel(examples: TasteExample[]): TasteModel {
  return { vectors: examples.map((x) => decode(x.e)), votes: examples.map((x) => x.v) }
}

/**
 * John's likely verdict on a photo, from his closest past decisions.
 * Returns lean in [-1, 1] (negative = he'd keep it, positive = he'd delete it)
 * and how many past decisions it is based on.
 */
export function tasteLean(embedding: Float32Array, model: TasteModel): { lean: number; n: number } {
  const hits: Array<{ sim: number; vote: number }> = []
  for (let i = 0; i < model.vectors.length; i++) {
    const v = model.vectors[i]
    let sim = 0
    for (let d = 0; d < v.length; d++) sim += v[d] * embedding[d]
    if (sim >= NEIGHBOR_SIMILARITY) hits.push({ sim, vote: model.votes[i] })
  }
  hits.sort((a, b) => b.sim - a.sim)
  const top = hits.slice(0, K)
  if (!top.length) return { lean: 0, n: 0 }
  const weight = top.reduce((s, h) => s + h.sim, 0)
  return { lean: top.reduce((s, h) => s + h.sim * h.vote, 0) / weight, n: top.length }
}

/**
 * How sure the tool is that John will want a suggested photo gone, 0..1.
 * Used to order batches so the easiest calls come first.
 */
export function certainty(j: Judgment | undefined, isLookalike: boolean, lean: number): number {
  let base = 0.4
  if (j?.score === 1) base = 0.9
  else if (isLookalike) base = 0.75
  else if (j?.score === 2) base = 0.65
  return Math.min(1, Math.max(0, base + 0.3 * lean))
}
