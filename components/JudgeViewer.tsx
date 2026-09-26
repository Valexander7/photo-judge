import ChevronLeftIcon from "@mui/icons-material/ChevronLeft"
import ChevronRightIcon from "@mui/icons-material/ChevronRight"
import CloseIcon from "@mui/icons-material/Close"
import OpenInNewIcon from "@mui/icons-material/OpenInNew"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import CircularProgress from "@mui/material/CircularProgress"
import Dialog from "@mui/material/Dialog"
import IconButton from "@mui/material/IconButton"
import Typography from "@mui/material/Typography"
import { useEffect, useRef, useState } from "react"

import type { Judgment } from "../lib/memory-judge"
import { buildThumbUrl } from "../lib/photo-url"
import type { GpdMediaItem } from "../lib/types"
import { useBlobUrl } from "./useBlobUrl"

// Full-screen photo viewer for Memory Judge.
// Keys: ← → next/previous, D toggles delete, Z or click zooms, Esc closes.

interface Props {
  items: GpdMediaItem[]
  index: number | null
  judgments: Record<string, Judgment>
  flagged: Set<string>
  onToggle: (mediaKey: string) => void
  onIndex: (index: number | null) => void
}

// Ask Google for the photo at screen size (sharp on Retina displays),
// and at twice that when zoomed in.
function sizedUrl(thumb: string, scale: number) {
  const dpr = window.devicePixelRatio || 1
  return buildThumbUrl(thumb, {
    width: Math.round(window.innerWidth * dpr * scale),
    height: Math.round(window.innerHeight * dpr * scale)
  })
}

export function JudgeViewer({ items, index, judgments, flagged, onToggle, onIndex }: Props) {
  const item = index !== null ? items[index] : undefined
  const [zoom, setZoom] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const clickRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 })

  const { blobUrl, loading } = useBlobUrl(item ? sizedUrl(item.thumb, zoom ? 2 : 1) : undefined)
  // Preload the next photo so arrowing through is quick.
  const next = index !== null ? items[index + 1] : undefined
  useBlobUrl(next ? sizedUrl(next.thumb, 1) : undefined)

  useEffect(() => setZoom(false), [index])

  // When zooming in, scroll so the spot that was clicked stays under the cursor.
  useEffect(() => {
    const el = scrollRef.current
    if (!zoom || !el || !blobUrl) return
    const { x, y } = clickRef.current
    el.scrollLeft = x * el.scrollWidth - el.clientWidth / 2
    el.scrollTop = y * el.scrollHeight - el.clientHeight / 2
  }, [zoom, blobUrl])

  useEffect(() => {
    if (index === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && index < items.length - 1) onIndex(index + 1)
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1)
      else if (e.key.toLowerCase() === "d" && item) onToggle(item.mediaKey)
      else if (e.key.toLowerCase() === "z") setZoom((z) => !z)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [index, items.length, item, onIndex, onToggle])

  if (!item || index === null) return null
  const j = judgments[item.mediaKey]
  const isFlagged = flagged.has(item.mediaKey)

  const handleImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    clickRef.current = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    setZoom((z) => !z)
  }

  return (
    <Dialog fullScreen open onClose={() => onIndex(null)} PaperProps={{ sx: { bgcolor: "#000" } }}>
      <Box
        sx={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 2,
          display: "flex", alignItems: "center", gap: 2, p: 1.5,
          color: "#fff", background: "linear-gradient(rgba(0,0,0,.7), transparent)"
        }}>
        <IconButton onClick={() => onIndex(null)} sx={{ color: "#fff" }}>
          <CloseIcon />
        </IconButton>
        <Typography sx={{ flexGrow: 1 }}>
          {index + 1} / {items.length}
          {j && ` · ${j.score}/5 · ${j.caption} · ${j.reason}`}
        </Typography>
        <IconButton
          href={item.productUrl ?? ""}
          target="_blank"
          title="Open original in Google Photos"
          sx={{ color: "#fff" }}>
          <OpenInNewIcon />
        </IconButton>
        <Button
          variant="contained"
          color={isFlagged ? "success" : "error"}
          onClick={() => onToggle(item.mediaKey)}>
          {isFlagged ? "Keep instead (D)" : "Mark delete (D)"}
        </Button>
      </Box>

      <Box
        ref={scrollRef}
        sx={{
          position: "absolute", inset: 0, overflow: zoom ? "auto" : "hidden",
          display: zoom ? "block" : "flex", alignItems: "center", justifyContent: "center",
          outline: isFlagged ? "4px solid #d32f2f" : "none", outlineOffset: -4
        }}>
        {blobUrl && (
          <img
            src={blobUrl}
            onClick={handleImageClick}
            style={
              zoom
                ? { display: "block", maxWidth: "none", width: "200vw", cursor: "zoom-out" }
                : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: "zoom-in" }
            }
          />
        )}
        {loading && (
          <CircularProgress sx={{ position: "absolute", top: "50%", left: "50%", color: "#fff" }} />
        )}
      </Box>

      {index > 0 && (
        <IconButton
          onClick={() => onIndex(index - 1)}
          sx={{ position: "absolute", left: 8, top: "50%", color: "#fff", bgcolor: "rgba(0,0,0,.4)" }}>
          <ChevronLeftIcon fontSize="large" />
        </IconButton>
      )}
      {index < items.length - 1 && (
        <IconButton
          onClick={() => onIndex(index + 1)}
          sx={{ position: "absolute", right: 8, top: "50%", color: "#fff", bgcolor: "rgba(0,0,0,.4)" }}>
          <ChevronRightIcon fontSize="large" />
        </IconButton>
      )}
    </Dialog>
  )
}
