#!/usr/bin/env python3
"""
Laya sidecar — semantic passage judging for the Agent Evidence API.

Why a sidecar rather than in-process: loading the model costs ~33 s and keeps
~2.9 GB resident (measured on a 4 vCPU EPYC). That must not share a cgroup, or
a lifecycle, with the API.

Why one HTTP call for N passages rather than N calls: the model scores ONE state
per forward pass, so scoring five passages means five passes. Keeping that loop
in Python avoids N HTTP round-trips.

Deliberately stdlib-only. The model is the dependency; a web framework would be
another one to audit and keep patched.

    POST /judge   {"question": "...", "passages": ["...", ...]}
               -> {"scores": [0.75, 0.0001, ...], "ms": 1234, "model": "..."}

    GET  /health -> {"status": "ok", "model": "...", "loaded": true}

Environment:
    LAYA_MODEL        default convaiinnovations/laya
    LAYA_DEVICE       default cpu
    LAYA_PORT         default 8077
    LAYA_INSTRUCTIONS optional instruction template; {q} is replaced by the question
    HF_HOME           must point somewhere writable in a sandboxed host
"""
from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_ID = os.environ.get("LAYA_MODEL", "convaiinnovations/laya")
DEVICE = os.environ.get("LAYA_DEVICE", "cpu")
PORT = int(os.environ.get("LAYA_PORT", "8077"))

# The question we ask about every passage. Kept to a single `noul` (P(true))
# probe because that is the one decision our lexical scorer cannot make: it
# separates "mentions the same words" from "actually answers this".
INSTRUCTIONS = os.environ.get(
    "LAYA_INSTRUCTIONS",
    "Does this passage directly answer the following question: {q}",
)

# One Agent, one lock. The model is not documented as thread-safe for
# concurrent forward passes, and serialising is the safe default.
_agent = None
_lock = threading.Lock()


def _load():
    global _agent
    import laya  # imported lazily so /health can answer before the model is up

    print(f"[laya] loading {MODEL_ID} on {DEVICE} (this takes ~30s)...", flush=True)
    t0 = time.time()
    _agent = laya.load(MODEL_ID, device=DEVICE)
    print(f"[laya] loaded in {time.time() - t0:.1f}s", flush=True)


def judge(question: str, passages: list[str]) -> dict:
    if _agent is None:
        raise RuntimeError("model not loaded")
    instructions = INSTRUCTIONS.replace("{q}", question)
    q = {"answers_question": {"type": "noul", "instructions": instructions}}

    scores: list[float] = []
    t0 = time.time()
    for text in passages:
        # Bound the state: the English checkpoint has a 512-token context and
        # silently truncates beyond it, which would judge the wrong text.
        state = text[:2000]
        with _lock:
            result = _agent.predict(state, q)
        answer = (result.get("answers") or {}).get("answers_question") or {}
        scores.append(float(answer.get("noul", 0.0)))
    return {
        "scores": scores,
        "ms": int((time.time() - t0) * 1000),
        "model": MODEL_ID,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {
                "status": "ok" if _agent is not None else "loading",
                "model": MODEL_ID,
                "device": DEVICE,
                "loaded": _agent is not None,
            })
        else:
            self._send(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/judge":
            return self._send(404, {"error": "not_found"})
        try:
            length = int(self.headers.get("content-length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            question = str(payload.get("question") or "").strip()
            passages = [str(p)[:2000] for p in (payload.get("passages") or [])][:32]
            if not question or not passages:
                return self._send(400, {"error": "question and passages are required"})
            if _agent is None:
                return self._send(503, {"error": "model_loading"})
            self._send(200, judge(question, passages))
        except Exception as exc:  # never leak a traceback to the caller
            self._send(500, {"error": "judge_failed", "detail": str(exc)[:200]})

    def log_message(self, fmt, *args):  # quieter default logging
        print(f"[laya] {self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    # Bind loopback only: this is never a public service.
    threading.Thread(target=_load, daemon=True).start()
    print(f"[laya] listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
