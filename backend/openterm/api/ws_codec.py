"""Binary WebSocket framing (used when the client opts into `action:"binary"`).

WIRE FORMAT — the frontend (frontend/src/lib/codec.ts) parses this byte for
byte. If you change ANY of it, change it there in the same commit:

    byte 0        : frame type (u8)
    bytes 1..4    : topic length (u32 BIG-endian; DataView default — the one
                    place endianness was never negotiated, so both sides just
                    agree. It's big-endian. Do not "modernize" it.)
    bytes 5..5+N  : topic (utf-8)
    rest          : msgpack payload; zstd-compressed iff type == COMPRESSED

Events above COMPRESS_THRESHOLD are sent as FRAME_COMPRESSED_EVENT with the
msgpack bytes zstd'd (browser side: fzstd). hello/pong payloads are empty or
JSON-only: hello ALWAYS travels as a JSON text frame even in binary mode —
the client's binary HELLO branch exists for historical reasons only.
"""
from __future__ import annotations

from typing import Any

import msgpack
import zstandard as zstd

# Frame types (keep in sync with frontend/src/lib/codec.ts)
FRAME_HELLO = 0            # reserved; hello is JSON text in practice
FRAME_EVENT = 1
FRAME_PONG = 2
FRAME_COMPRESSED_EVENT = 3

# Payloads above this get zstd'd and the frame type flips to COMPRESSED.
COMPRESS_THRESHOLD = 1024

# Sanity caps for decoding frames from untrusted sockets.
_MAX_TOPIC_LEN = 64 * 1024
_MAX_DECOMPRESSED = 8 * 1024 * 1024  # decompression-bomb guard (zstd dict attacks)

_compressor = zstd.ZstdCompressor(level=3)
_decompressor = zstd.ZstdDecompressor()


def encode_frame(frame_type: int, topic: str | None, data: Any) -> bytes:
    topic_bytes = (topic or "").encode("utf-8")
    payload = msgpack.packb(data, use_bin_type=True)
    if frame_type == FRAME_EVENT and len(payload) > COMPRESS_THRESHOLD:
        payload = _compressor.compress(payload)
        frame_type = FRAME_COMPRESSED_EVENT
    frame = bytearray()
    frame.append(frame_type)
    frame.extend(len(topic_bytes).to_bytes(4, "big"))
    frame.extend(topic_bytes)
    frame.extend(payload)
    return bytes(frame)


def decode_frame(data: bytes) -> tuple[int, str | None, Any]:
    """Decode exactly ONE frame. Returns (frame_type, topic, payload)."""
    if len(data) < 5:
        raise ValueError("Frame too short")
    frame_type = data[0]
    topic_len = int.from_bytes(data[1:5], "big")
    if topic_len > _MAX_TOPIC_LEN:
        # A u32 length straight off the wire is attacker/bugger controlled;
        # refuse absurd values before trusting anything downstream.
        raise ValueError("absurd topic length")
    if len(data) < 5 + topic_len:
        raise ValueError("Frame truncated")
    topic = data[5:5 + topic_len].decode("utf-8") if topic_len else None
    payload_data = data[5 + topic_len:]
    if frame_type == FRAME_COMPRESSED_EVENT:
        payload_data = _decompressor.decompress(
            payload_data, max_output_size=_MAX_DECOMPRESSED
        )
    return frame_type, topic, msgpack.unpackb(payload_data, raw=False)


def encode_pong() -> bytes:
    return encode_frame(FRAME_PONG, None, {})


def encode_event(topic: str, data: Any) -> bytes:
    return encode_frame(FRAME_EVENT, topic, data)
