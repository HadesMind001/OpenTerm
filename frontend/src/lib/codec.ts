import * as msgpack from '@msgpack/msgpack'
import { decompress as zstdDecompress } from 'fzstd'

// Frame types — MUST match backend/openterm/api/ws_codec.py byte for byte.
// The wire format (type u8 | topic_len u32 BIG-endian | topic | payload) is
// documented there; the endianness was never negotiated, it is simply agreed.
export const FRAME_HELLO = 0
export const FRAME_EVENT = 1
export const FRAME_PONG = 2
export const FRAME_COMPRESSED_EVENT = 3

// Mirror of the backend's decode guard. A hostile/mangled u32 here otherwise
// says "topic is 4 GiB long" and TextDecoder happily starves the renderer.
const MAX_TOPIC_LEN = 64 * 1024

/**
 * Decode one binary frame. The client never ENCODES frames (commands are
 * plain JSON), which is why the old encodeFrame() and FrameDecoder live here
 * are gone: FrameDecoder could not even work — the wire format has no
 * payload-length field, so a multi-frame TCP buffer can never be split by it.
 */
export function decodeBinaryFrame(
  data: ArrayBuffer,
): { type: number; topic: string | null; payload: unknown } {
  if (data.byteLength < 5) {
    throw new Error('Frame too short')
  }
  const view = new DataView(data)
  const frameType = view.getUint8(0)
  const topicLen = view.getUint32(1) // DataView is big-endian by default
  if (topicLen > MAX_TOPIC_LEN) {
    throw new Error('absurd topic length')
  }
  if (data.byteLength < 5 + topicLen) {
    throw new Error('Frame truncated')
  }

  let topic: string | null = null
  if (topicLen > 0) {
    topic = new TextDecoder().decode(new Uint8Array(data, 5, topicLen))
  }
  const payloadBytes = new Uint8Array(data, 5 + topicLen)
  const payload =
    frameType === FRAME_COMPRESSED_EVENT
      ? msgpack.decode(zstdDecompress(payloadBytes))
      : msgpack.decode(payloadBytes)

  return { type: frameType, topic, payload }
}
