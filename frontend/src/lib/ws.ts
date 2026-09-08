import type { Frame } from './types'
import { decodeBinaryFrame, FRAME_EVENT, FRAME_COMPRESSED_EVENT, FRAME_PONG } from './codec'

type Listener = (f: Frame) => void
const listeners = new Set<Listener>()

// Dev goes through the Vite proxy (server['/ws'].ws === true in vite.config),
// prod through the same origin the page was served from. The old dev build
// hardcoded ws://localhost:8000 and left the /ws proxy entry as decorative
// dead config.
const getWsUrl = () =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`

// Keepalive cadence. The backend answers {action:'ping'} with a pong; without
// app-level pings a silently-half-opened TCP socket never fires onclose and
// the UI sits on a "stream connected" banner over a corpse.
const PING_MS = 25_000
const DEAD_MS = 75_000

/**
 * Connect the market WS with a bulletproof lifecycle.
 *
 * The previous implementation reconnected by recursively calling connectWS()
 * and DISCARDING the returned handle — after one reconnect, "disconnect"
 * closed a zombie socket while the real one and its reconnect chain kept
 * living (StrictMode double-mount made this a festering leak of parallel
 * sockets, and the shared module-global `backoff` meant they throttled each
 * other). Now: one controller object owns the current socket + timer and the
 * returned disconnect kills the whole lineage.
 */
export function connectWS(onStatus: (up: boolean) => void): () => void {
  let alive = true
  let sock: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  let backoff = 500
  let lastRx = Date.now()

  const emit = (f: Frame) => listeners.forEach((l) => l(f))

  const open = () => {
    if (!alive) return
    sock = new WebSocket(getWsUrl())
    sock.binaryType = 'arraybuffer'
    const s = sock

    s.onopen = () => {
      backoff = 500
      lastRx = Date.now()
      onStatus(true)
      s.send(
        JSON.stringify({
          action: 'sub',
          patterns: ['tick:*', 'quote:*', 'stats:*', 'bar:*', 'news:*', 'status:*', 'depth:*', 'bot:*'],
        }),
      )
      // Events as msgpack+zstd; hello stays JSON by protocol design.
      s.send(JSON.stringify({ action: 'binary' }))
      interval = setInterval(() => {
        if (s.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastRx > DEAD_MS) {
          // No data AND no pong for DEAD_MS: the pipe is a zombie. Force-close
          // to trigger onclose → the normal reconnect path.
          s.close()
          return
        }
        s.send(JSON.stringify({ action: 'ping' }))
      }, PING_MS)
    }

    s.onmessage = (e) => {
      lastRx = Date.now()
      if (typeof e.data === 'string') {
        try {
          emit(JSON.parse(e.data) as Frame)
        } catch {
          /* malformed JSON frame ignored */
        }
        return
      }
      if (e.data instanceof ArrayBuffer) {
        try {
          const { type, topic, payload } = decodeBinaryFrame(e.data)
          if ((type === FRAME_EVENT || type === FRAME_COMPRESSED_EVENT) && topic) {
            // The compressed case was THE bug: the backend flips any event
            // with a payload over 1 KiB to FRAME_COMPRESSED_EVENT (depth
            // snapshots are always above it), codec.ts happily decompressed
            // it… and then this file only forwarded type === FRAME_EVENT.
            // Every large frame was decoded, checked, and silently thrown in
            // the trash. Debugging THAT from the UI is how a weekend dies.
            emit({ t: 'e', topic, data: payload as Record<string, unknown> })
          } else if (type === FRAME_PONG) {
            emit({ t: 'pong' } as Frame)
          }
        } catch {
          /* malformed binary frame ignored */
        }
      }
    }

    s.onclose = () => {
      onStatus(false)
      if (interval) {
        clearInterval(interval)
        interval = null
      }
      if (!alive) return
      const delay = backoff
      backoff = Math.min(backoff * 2, 10_000)
      // Hidden tabs get throttled by browsers anyway; reconnecting into a
      // timer-storm while nobody looks is rude — wait for visibility instead.
      timer = setTimeout(() => {
        if (document.hidden) {
          const vis = () => {
            document.removeEventListener('visibilitychange', vis)
            open()
          }
          document.addEventListener('visibilitychange', vis)
        } else {
          open()
        }
      }, delay)
    }

    s.onerror = () => s.close()
  }

  open()

  return () => {
    alive = false
    if (timer) clearTimeout(timer)
    if (interval) clearInterval(interval)
    sock?.close()
    sock = null
  }
}

export function onFrame(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
