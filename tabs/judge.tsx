import Alert from "@mui/material/Alert"
import AppBar from "@mui/material/AppBar"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import CssBaseline from "@mui/material/CssBaseline"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import LinearProgress from "@mui/material/LinearProgress"
import Slider from "@mui/material/Slider"
import FormControlLabel from "@mui/material/FormControlLabel"
import Stack from "@mui/material/Stack"
import Switch from "@mui/material/Switch"
import { ThemeProvider } from "@mui/material/styles"
import TextField from "@mui/material/TextField"
import Toolbar from "@mui/material/Toolbar"
import Typography from "@mui/material/Typography"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { JudgeViewer } from "../components/JudgeViewer"
import { useBlobUrl } from "../components/useBlobUrl"

import {
  createJudgeSession,
  groupIntoMoments,
  judgePhoto,
  paced,
  coolerMode,
  loadJudgments,
  modelStatus,
  saveJudgments,
} from "../lib/memory-judge"
import type { Judgment, Moment } from "../lib/memory-judge"
import { compareMoments, mergeSuggestions } from "../lib/scene-judge"
import { findLookalikes, fingerprint } from "../lib/lookalikes"
import type { Fingerprint } from "../lib/lookalikes"
import { addTaste, buildModel, certainty, loadTaste, removeTaste, tasteLean } from "../lib/taste"
import type { TasteExample } from "../lib/taste"
import type { RepeatSuggestion } from "../lib/scene-judge"
import { buildThumbUrl } from "../lib/photo-url"
import theme from "../lib/theme"
import { APP_ID } from "../lib/types"
import type {
  AppMessage,
  GpdMediaItem,
  GptkResultChunkMessage,
  GptkResultMessage,
  HealthCheckResultMessage
} from "../lib/types"

// Memory Judge: pick a date range, let Chrome's on-device AI rate every photo,
// review the suggestions, then move the chosen ones to Google Photos trash.

type Phase =
  | { name: "setup" }
  | { name: "fetching"; count: number }
  | { name: "judging"; done: number; total: number }
  | { name: "comparing"; done: number; total: number; failed: number }
  | { name: "fingerprinting"; done: number; total: number }
  | { name: "review" }
  | { name: "trashing" }
  | { name: "trashed"; count: number }

const DAY_MS = 24 * 60 * 60 * 1000

function send(message: AppMessage) {
  chrome.runtime.sendMessage(message)
}

// After a trash, save the list of trashed photos so the Mac script
// (~/Developer/photo-cull/sync_deleted.py) can remove the same photos from
// Apple Photos. Without that, the Apple copies could be backed up again.
function downloadTrashedList(items: GpdMediaItem[], kind: "trashed" | "restored" = "trashed") {
  const list = items.map((i) => ({
    mediaKey: i.mediaKey,
    timestamp: i.timestamp,
    fileName: i.fileName ?? null,
    width: i.resWidth ?? null,
    height: i.resHeight ?? null
  }))
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "")
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([JSON.stringify(list, null, 1)], { type: "application/json" }))
  a.download = `${stamp.slice(0, 10)} Photo Judge ${kind} in Google - ${list.length} photos ${stamp.slice(11)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function newRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })
}

// Thumbnails must be fetched with the Google sign-in cookies, so a plain
// <img src> shows blank. Load each one only when it scrolls into view.
function Thumb({ thumb }: { thumb: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: "600px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const { blobUrl } = useBlobUrl(visible ? buildThumbUrl(thumb, { height: 300 }) : undefined)
  return (
    <Box ref={ref} sx={{ height: 150, bgcolor: "action.hover" }}>
      {blobUrl && (
        <img
          src={blobUrl}
          style={{ width: "100%", height: 150, objectFit: "cover", display: "block", cursor: "zoom-in" }}
        />
      )}
    </Box>
  )
}

export default function Judge() {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [account, setAccount] = useState("")
  const [model, setModel] = useState("checking")
  const [download, setDownload] = useState<number | null>(null)
  const [from, setFrom] = useState("2026-06-12")
  const [to, setTo] = useState("2026-06-20")
  const [phase, setPhase] = useState<Phase>({ name: "setup" })
  const [error, setError] = useState("")
  const [moments, setMoments] = useState<Moment[]>([])
  const [judgments, setJudgments] = useState<Record<string, Judgment>>({})
  const [aiFlagged, setFlagged] = useState<Set<string>>(new Set())
  const [prints, setPrints] = useState<Record<string, Fingerprint>>({})
  // John prefers the loose setting (2026-09-26); remember his last choice.
  const [similarity, setSimilarityState] = useState(() => {
    try { return Number(localStorage.getItem("lookalikeSimilarity")) || 0.8 } catch { return 0.8 }
  })
  const setSimilarity = (v: number) => {
    setSimilarityState(v)
    try { localStorage.setItem("lookalikeSimilarity", String(v)) } catch { /* not critical */ }
  }
  const [onlySuggested, setOnlySuggested] = useState(false)
  // Review in small batches, most certain first (John, 2026-09-26: "I can
  // only check so much"). Remember his preferred batch size.
  const [batchSize, setBatchSizeState] = useState(() => {
    try { return Number(localStorage.getItem("batchSize")) || 50 } catch { return 50 }
  })
  const setBatchSize = (n: number) => {
    setBatchSizeState(n)
    try { localStorage.setItem("batchSize", String(n)) } catch { /* not critical */ }
  }
  const [taste, setTaste] = useState<TasteExample[]>([])
  const [cooler, setCooler] = useState(coolerMode)
  const tasteRef = useRef(taste)
  tasteRef.current = taste
  const reviewedRef = useRef<Array<{ key: string; deleted: boolean }>>([])
  // Keep/Delete clicks are saved, so reloading the page doesn't lose them.
  const [manual, setManualState] = useState<Record<string, boolean>>({})
  const setManual = useCallback((update: (prev: Record<string, boolean>) => Record<string, boolean>) =>
    setManualState((prev) => {
      const next = update(prev)
      chrome.storage?.local.set({ manualChoices: next }).catch(() => {})
      return next
    }), [])
  const [repeats, setRepeats] = useState<Record<string, RepeatSuggestion>>({})
  const [comparisonNote, setComparisonNote] = useState("")
  const [confirm, setConfirm] = useState(false)
  const trashingRef = useRef<GpdMediaItem[]>([])
  const [lastTrashed, setLastTrashed] = useState<GpdMediaItem[]>([])
  const lastTrashedRef = useRef<GpdMediaItem[]>([])
  lastTrashedRef.current = lastTrashed
  const [restoredCount, setRestoredCount] = useState<number | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)

  const requestRef = useRef<string | null>(null)
  const chunksRef = useRef<GpdMediaItem[][]>([])
  const abortRef = useRef<AbortController | null>(null)
  const rangeRef = useRef({ from, to })
  rangeRef.current = { from, to }

  useEffect(() => {
    modelStatus().then(setModel)
    loadTaste().then(setTaste)
    send({ app: APP_ID, action: "healthCheck" })
  }, [])

  const runComparisons = useCallback(async (ms: Moment[], cache: Record<string, Judgment>, abort: AbortController) => {
    setComparisonNote("")
    setPhase({ name: "comparing", done: 0, total: 0, failed: 0 })
    try {
      const result = await compareMoments(ms, cache, abort.signal,
        (progress) => setPhase({ name: "comparing", ...progress }))
      setFlagged(result.flagged)
      setRepeats(result.repeats)
      setComparisonNote(result.stopped
        ? `Comparison stopped after ${result.done} of ${result.total} groups. Review is incomplete.`
        : result.failed
          ? `${result.failed} of ${result.total} comparisons failed. Those groups received no new repeat suggestions.`
          : `Compared ${result.total} groups of nearby photos. Repeated shots link to the suggested keeper. Check every suggestion before deleting.`)
    } catch (e) {
      setComparisonNote(`Scene comparison unavailable: ${e instanceof Error ? e.message : String(e)}. Existing suggestions are unchanged.`)
    } finally {
      setPhase({ name: "review" })
    }
  }, [])

  const startJudging = useCallback(async (all: GpdMediaItem[]) => {
    const start = new Date(rangeRef.current.from).getTime()
    const end = new Date(rangeRef.current.to).getTime() + DAY_MS
    const photos = all.filter(
      (i) => i.duration === undefined && i.timestamp >= start && i.timestamp < end
    )
    const ms = groupIntoMoments(photos)
    setMoments(ms)
    try {
      const saved = await chrome.storage.local.get("manualChoices")
      setManualState((saved.manualChoices as Record<string, boolean>) ?? {})
    } catch {
      setManualState({}) // saved choices unavailable; start fresh
    }
    setPrints({})
    setRepeats({})
    setComparisonNote("")

    const cache = await loadJudgments()
    setJudgments({ ...cache })
    const todo = photos.filter((p) => !cache[p.mediaKey])
    setPhase({ name: "judging", done: photos.length - todo.length, total: photos.length })

    const abort = new AbortController()
    abortRef.current = abort
    let session: Awaited<ReturnType<typeof createJudgeSession>> | undefined
    try {
      if (todo.length) session = await createJudgeSession(setDownload)
      setDownload(null)
      let done = photos.length - todo.length
      for (const item of todo) {
        if (abort.signal.aborted) break
        try {
          cache[item.mediaKey] = await paced(() => judgePhoto(session!, item, abort.signal), abort.signal)
        } catch (e) {
          if (abort.signal.aborted) break
          console.warn("[Judge] skipped", item.mediaKey, e)
        }
        done++
        setPhase({ name: "judging", done, total: photos.length })
        if (done % 10 === 0) {
          setJudgments({ ...cache })
          await saveJudgments(cache)
        }
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      session?.destroy()
    }
    await saveJudgments(cache)
    setJudgments({ ...cache })
    setFlagged(mergeSuggestions(ms, cache, []).flagged)
    // The AI scene comparison is the heaviest GPU step, and the look-alike
    // check now catches most repeats, so it runs only when John asks.
    setComparisonNote("Look-alikes checked. \"Compare repeated shots\" runs a deeper AI check if you want it (heavier on the GPU).")
    if (!abort.signal.aborted) {
      setPhase({ name: "fingerprinting", done: 0, total: photos.length })
      try {
        setPrints(await fingerprint(photos, (done, total) =>
          setPhase({ name: "fingerprinting", done, total }), abort.signal))
      } catch (e) {
        if (!abort.signal.aborted) setError(`Look-alike check failed: ${e instanceof Error ? e.message : e}`)
      }
    }
    setPhase({ name: "review" })
  }, [runComparisons])

  useEffect(() => {
    const listener = (message: AppMessage, sender: chrome.runtime.MessageSender) => {
      if (message?.app !== APP_ID || sender.tab) return
      if (message.action === "healthCheck.result") {
        const m = message as HealthCheckResultMessage
        setConnected(m.success && m.hasGptk)
        setAccount(m.accountEmail ?? "")
      } else if (message.action === "gptkProgress") {
        const p = message as { command?: string; itemsProcessed: number }
        if (!p.command) setPhase({ name: "fetching", count: p.itemsProcessed })
      } else if (message.action === "gptkResultChunk") {
        const c = message as GptkResultChunkMessage
        if (c.requestId !== requestRef.current) return
        chunksRef.current[c.chunkIndex] = c.data as GpdMediaItem[]
        if (chunksRef.current.filter(Boolean).length === c.totalChunks) {
          requestRef.current = null
          startJudging(chunksRef.current.flat())
        }
      } else if (message.action === "gptkResult") {
        const r = message as GptkResultMessage
        if (r.command === "restoreItems") {
          if (r.success) {
            // Tell the Mac to take these back out of the Apple delete albums,
            // and forget what this batch taught (FMEA K2).
            const restored = lastTrashedRef.current
            downloadTrashedList(restored, "restored")
            removeTaste(tasteRef.current, new Set(restored.map((i) => i.mediaKey))).then(setTaste)
            setRestoredCount(restored.length)
          } else {
            setError(r.error ?? "Could not restore the photos. Restore them from Google Photos trash.")
          }
        } else if (r.command === "trashItems") {
          if (r.success) {
            const count = (r.data as { trashedCount: number }).trashedCount
            setPhase({ name: "trashed", count })
            setLastTrashed(trashingRef.current)
            setRestoredCount(null)
            downloadTrashedList(trashingRef.current)
            // Learn from this batch, then take the trashed photos off the page.
            const gone = new Set(trashingRef.current.map((i) => i.mediaKey))
            const decisions = reviewedRef.current
              .filter((d) => printsRef.current[d.key])
              .map((d) => ({ embedding: printsRef.current[d.key].embedding, deleted: d.deleted, key: d.key }))
            addTaste(tasteRef.current, decisions).then(setTaste)
            setMoments((ms) => ms
              .map((m) => ({ ...m, items: m.items.filter((i) => !gone.has(i.mediaKey)) }))
              .filter((m) => m.items.length > 0))
            setManual((prev) => {
              const next = { ...prev }
              for (const d of reviewedRef.current) delete next[d.key]
              return next
            })
          } else {
            setError(r.error ?? "Could not move photos to trash.")
            setPhase({ name: "review" })
          }
        } else if (r.command === "getAllMediaItems" && !r.success) {
          setError(r.error ?? "Could not read Google Photos.")
          setPhase({ name: "setup" })
        }
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [startJudging])

  const handleStart = useCallback(async () => {
    setError("")
    // Photos taken in the range can't have been uploaded before it, so the
    // library fetch can stop there. Two days of margin covers time zones.
    const sinceTimestamp = new Date(from).getTime() - 2 * DAY_MS
    const requestId = newRequestId()
    requestRef.current = requestId
    chunksRef.current = []
    setPhase({ name: "fetching", count: 0 })
    send({
      app: APP_ID,
      action: "gptkCommand",
      command: "getAllMediaItems",
      requestId,
      args: { sinceTimestamp }
    })
  }, [from])

  const itemsByKey = useMemo(() => {
    const map: Record<string, GpdMediaItem> = {}
    for (const m of moments) for (const i of m.items) map[i.mediaKey] = i
    return map
  }, [moments])

  const allItems = useMemo(() => moments.flatMap((m) => m.items), [moments])
  const indexByKey = useMemo(() => {
    const map: Record<string, number> = {}
    allItems.forEach((item, i) => (map[item.mediaKey] = i))
    return map
  }, [allItems])

  // Look-alike runs, recomputed instantly when the similarity slider moves.
  const lookalikes = useMemo(
    () => findLookalikes(moments, prints, judgments, similarity),
    [moments, prints, judgments, similarity])
  const lookalikeOf = useMemo(() => {
    const map: Record<string, string> = {}
    for (const g of lookalikes) for (const k of g.extras) map[k] = g.keepers[0]
    return map
  }, [lookalikes])

  const printsRef = useRef(prints)
  printsRef.current = prints
  const tasteModel = useMemo(() => buildModel(taste), [taste])
  const leanOf = useCallback((key: string) => {
    const fp = prints[key]
    return fp ? tasteLean(fp.embedding, tasteModel) : { lean: 0, n: 0 }
  }, [prints, tasteModel])

  // Everything the tool would suggest, most certain first. Photos that look
  // like ones John has kept before are dropped ("learnedKeep").
  const { queue, queued, learnedKeep } = useMemo(() => {
    const all = new Set(aiFlagged)
    Object.keys(lookalikeOf).forEach((k) => all.add(k))
    const learnedKeep = new Set<string>()
    const scored: Array<{ key: string; c: number }> = []
    for (const key of all) {
      if (!itemsByKey[key]) continue
      const { lean, n } = leanOf(key)
      if (n >= 2 && lean <= -0.5) { learnedKeep.add(key); continue }
      scored.push({ key, c: certainty(judgments[key], !!lookalikeOf[key], lean) })
    }
    scored.sort((a, b) => b.c - a.c)
    const queue = scored.map((x) => x.key)
    return { queue, queued: new Set(queue), learnedKeep }
  }, [aiFlagged, lookalikeOf, judgments, leanOf, itemsByKey])

  const batch = useMemo(() => new Set(queue.slice(0, batchSize)), [queue, batchSize])
  const waiting = Math.max(0, queue.length - batchSize)

  // Final marks for this batch, with John's clicks on top.
  const flagged = useMemo(() => {
    const out = new Set(batch)
    for (const [k, marked] of Object.entries(manual)) marked ? out.add(k) : out.delete(k)
    return out
  }, [batch, manual])
  const flaggedRef = useRef(flagged)
  flaggedRef.current = flagged

  const toggle = useCallback((key: string) =>
    setManual((prev) => ({ ...prev, [key]: !flaggedRef.current.has(key) })), [])

  const handleTrash = () => {
    setConfirm(false)
    const keys = [...flagged].filter((k) => itemsByKey[k])
    trashingRef.current = keys.map((k) => itemsByKey[k])
    // What John decided on in this batch: every suggestion he saw, plus any
    // photo he marked himself. Suggested-then-kept teaches "I like these".
    const seen = new Set([...batch, ...Object.keys(manual)])
    reviewedRef.current = [...seen].filter((k) => itemsByKey[k]).map((k) => ({ key: k, deleted: flagged.has(k) }))
    setPhase({ name: "trashing" })
    send({
      app: APP_ID,
      action: "gptkCommand",
      command: "trashItems",
      requestId: newRequestId(),
      args: {
        dedupKeys: keys.map((k) => itemsByKey[k].dedupKey),
        mediaKeysToTrash: keys
      }
    })
  }

  const totalPhotos = moments.reduce((n, m) => n + m.items.length, 0)

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Memory Judge
          </Typography>
          {phase.name === "review" && (
            <>
              <Box>
                <Typography variant="body2">
                  This batch: {flagged.size} to delete · {waiting} more waiting
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Batch size{" "}
                  <select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))}>
                    {[20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  {taste.length > 0 && ` · learned from ${taste.length} choices`}
                  {" · "}
                  <label title="Rest between AI steps so the GPU runs cooler. Slower.">
                    <input type="checkbox" checked={cooler} onChange={(e) => {
                      setCooler(e.target.checked)
                      try { localStorage.setItem("coolerMode", e.target.checked ? "1" : "0") } catch { /* not critical */ }
                    }} /> run cooler
                  </label>
                </Typography>
              </Box>
              {Object.keys(prints).length > 0 && (
                <Box sx={{ width: 220, px: 1 }} title="How alike two shots must be to count as repeats">
                  <Typography variant="caption">
                    Look-alikes: {similarity < 0.87 ? "loose" : similarity > 0.93 ? "only near-identical" : "balanced"}
                  </Typography>
                  <Slider size="small" min={0.75} max={0.97} step={0.01} value={similarity}
                    onChange={(_, v) => setSimilarity(v as number)} />
                </Box>
              )}
              <Button onClick={() => {
                const abort = new AbortController()
                abortRef.current = abort
                runComparisons(moments, judgments, abort)
              }}>Compare repeated shots</Button>
              <Button
                variant="contained"
                color="error"
                disabled={flagged.size === 0}
                onClick={() => setConfirm(true)}>
                Move {flagged.size} to trash
              </Button>
            </>
          )}
          <Button size="small" href={chrome.runtime.getURL("tabs/app.html")}>
            Duplicate finder
          </Button>
        </Toolbar>
      </AppBar>

      <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
            {error}
          </Alert>
        )}

        {phase.name === "setup" && (
          <Stack spacing={2} sx={{ maxWidth: 520 }}>
            {connected === false && (
              <Alert severity="warning">
                Open photos.google.com in another tab, reload it, then reload this page.
              </Alert>
            )}
            {connected && <Typography>Connected to {account || "Google Photos"}.</Typography>}
            {(model === "missing" || model === "unavailable") && (
              <Alert severity="warning">
                Chrome's built-in AI isn't ready. In a new tab open
                chrome://flags/#prompt-api-for-gemini-nano-multimodal-input, set it to
                Enabled, and restart Chrome.
              </Alert>
            )}
            {model === "downloadable" && (
              <Alert severity="info">
                The first run downloads Chrome's AI model (a few GB, one time only).
              </Alert>
            )}
            <Typography>
              Pick the days to review. Every photo is rated on this computer; nothing
              is uploaded anywhere. You review everything before anything is deleted.
            </Typography>
            <Stack direction="row" spacing={2}>
              <TextField
                label="From"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="To"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Stack>
            <Button
              variant="contained"
              disabled={!connected || model === "missing" || model === "unavailable"}
              onClick={handleStart}>
              Review these photos
            </Button>
          </Stack>
        )}

        {phase.name === "fetching" && (
          <Stack spacing={1}>
            <Typography>Reading your Google Photos library… {phase.count} items so far</Typography>
            <LinearProgress />
          </Stack>
        )}

        {phase.name === "judging" && (
          <Stack spacing={1}>
            <Typography>
              {download !== null
                ? `Downloading Chrome's AI model… ${Math.round(download * 100)}%`
                : `Looking at photo ${phase.done} of ${phase.total}`}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={download !== null ? download * 100 : (phase.done / Math.max(1, phase.total)) * 100}
            />
            <Box>
              <Button onClick={() => abortRef.current?.abort()}>
                Stop and review what's done
              </Button>
            </Box>
          </Stack>
        )}

        {phase.name === "comparing" && (
          <Stack spacing={1}>
            <Typography>Comparing repeated shots… {phase.done} of {phase.total} groups</Typography>
            <LinearProgress variant={phase.total ? "determinate" : "indeterminate"}
              value={100 * phase.done / Math.max(1, phase.total)} />
            <Typography variant="body2">Keeping representatives of each scene, plus distinct expressions, people and details.</Typography>
            <Button onClick={() => abortRef.current?.abort()}>Stop and review what's done</Button>
          </Stack>
        )}

        {phase.name === "fingerprinting" && (
          <Stack spacing={1}>
            <Typography>Finding look-alike shots… {phase.done} of {phase.total}</Typography>
            <LinearProgress variant="determinate" value={100 * phase.done / Math.max(1, phase.total)} />
            <Button onClick={() => abortRef.current?.abort()}>Skip</Button>
          </Stack>
        )}

        {phase.name === "trashing" && (
          <Stack spacing={1}>
            <Typography>Moving photos to trash…</Typography>
            <LinearProgress />
          </Stack>
        )}

        {phase.name === "trashed" && (
          <Alert severity="success">
            Moved {phase.count} photos to Google Photos trash. They can be restored from
            the trash for 60 days.
            <br />
            A list of these photos was saved to your Downloads folder. Your Mac puts the
            same photos in Apple Photos' "Deleted in Google" album and notifies you;
            delete them there.
            <Button size="small" onClick={() => downloadTrashedList(lastTrashed)}>
              Save the list again
            </Button>
            <br />
            Your choices in this batch were remembered to improve the next ones.
            <br />
            {restoredCount === null ? (
              <Button size="small" color="inherit" onClick={() => send({
                app: APP_ID, action: "gptkCommand", command: "restoreItems", requestId: newRequestId(),
                args: { dedupKeys: lastTrashed.map((i) => i.dedupKey) }
              })}>
                Undo this batch (restore from Google trash)
              </Button>
            ) : (
              <>Restored {restoredCount} photos in Google Photos. Your Mac takes them back out of the
                Apple delete album. Reload this page to see them again. If you restore photos
                straight from Google Photos trash instead, their Apple copies stay in the delete
                album: take them out there by hand.</>
            )}
            <Button size="small" variant="contained" sx={{ ml: 1 }} onClick={() => setPhase({ name: "review" })}>
              Next batch
            </Button>
          </Alert>
        )}

        {phase.name === "review" && (
          <Stack spacing={4}>
            {comparisonNote && <Alert severity="info">{comparisonNote}</Alert>}
            <Typography variant="body2" color="text.secondary">
              Red = suggested for deletion. The button under each photo switches Keep/Delete. Click a photo to see it full screen (arrows to move, D to mark delete, click or Z to zoom).
            </Typography>
            <FormControlLabel
              control={<Switch checked={onlySuggested} onChange={(e) => setOnlySuggested(e.target.checked)} />}
              label="Only show moments with suggestions"
            />
            {moments.map((m) => {
              const inMoment = m.items.filter((i) => flagged.has(i.mediaKey)).length
              if (onlySuggested && inMoment === 0) return null
              const setAll = (del: boolean) => setManual((prev) => {
                const next = { ...prev }
                for (const i of m.items) next[i.mediaKey] = del
                return next
              })
              return (
                <Box key={m.id}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                    <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
                      {fmt(m.items[0].timestamp)} · {m.items.length} photos
                      {inMoment > 0 && ` · ${inMoment} suggested`}
                    </Typography>
                    <Button size="small" onClick={() => setAll(false)}>Keep all</Button>
                    <Button size="small" color="error" onClick={() => setAll(true)}>Delete all</Button>
                  </Stack>
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                      gap: 1
                    }}>
                    {m.items.map((item) => {
                      const j = judgments[item.mediaKey]
                      const isFlagged = flagged.has(item.mediaKey)
                      return (
                        <Box
                          key={item.mediaKey}
                          sx={{
                            border: 3,
                            borderColor: isFlagged ? "error.main" : "transparent",
                            borderRadius: 1
                          }}>
                          <Box
                            onClick={() => setViewing(indexByKey[item.mediaKey])}
                            sx={{ opacity: isFlagged ? 0.6 : 1 }}>
                            <Thumb thumb={item.thumb} />
                          </Box>
                          {learnedKeep.has(item.mediaKey) && !isFlagged && (
                            <Typography variant="caption" display="block" sx={{ p: 0.5, color: "success.main" }}>
                              You usually keep photos like this
                            </Typography>
                          )}
                          {!isFlagged && queued.has(item.mediaKey) && !batch.has(item.mediaKey) && (
                            <Typography variant="caption" display="block" sx={{ p: 0.5, color: "text.secondary" }}>
                              Suggested for a later batch
                            </Typography>
                          )}
                          {isFlagged && !repeats[item.mediaKey] && lookalikeOf[item.mediaKey] && (
                            <Box sx={{ p: 0.5 }}>
                              <Typography variant="caption" display="block">Look-alike of a sharper/better shot</Typography>
                              <Button size="small" onClick={() => setViewing(indexByKey[lookalikeOf[item.mediaKey]])}>
                                View the one kept
                              </Button>
                            </Box>
                          )}
                          {isFlagged && repeats[item.mediaKey] && (
                            <Box sx={{ p: 0.5 }}>
                              <Typography variant="caption" display="block">Repeat: {repeats[item.mediaKey].reason}</Typography>
                              <Button size="small" onClick={() => setViewing(indexByKey[repeats[item.mediaKey].keeper])}>
                                {flagged.has(repeats[item.mediaKey].keeper) ? "View alternative (also marked delete)" : "View suggested keeper"}
                              </Button>
                            </Box>
                          )}
                          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, p: 0.5 }}>
                            <Typography variant="caption" sx={{ flexGrow: 1 }}>
                              {j ? `${j.score}/5 · ${j.reason}` : "Not rated"}
                            </Typography>
                            <Button
                              size="small"
                              color={isFlagged ? "error" : "inherit"}
                              variant={isFlagged ? "contained" : "outlined"}
                              onClick={() => toggle(item.mediaKey)}
                              sx={{ minWidth: 0, flexShrink: 0, px: 1, py: 0, fontSize: 11 }}>
                              {isFlagged ? "Delete" : "Keep"}
                            </Button>
                          </Box>
                        </Box>
                      )
                    })}
                  </Box>
                </Box>
              )
            })}
          </Stack>
        )}
      </Box>

      <JudgeViewer
        items={allItems}
        index={viewing}
        judgments={judgments}
        flagged={flagged}
        onToggle={toggle}
        onIndex={setViewing}
      />

      <Dialog open={confirm} onClose={() => setConfirm(false)}>
        <DialogTitle>Move {flagged.size} photos to trash?</DialogTitle>
        <DialogContent>
          They go to Google Photos trash and can be restored for 60 days. Apple
          Photos is not affected.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleTrash}>
            Move to trash
          </Button>
        </DialogActions>
      </Dialog>
    </ThemeProvider>
  )
}
