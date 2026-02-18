import asyncio
import io
import json
import platform
import struct
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import onnxruntime as rt
import soundfile as sf
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

VOICES = {
    "American Female": [
        {"id": "af_heart", "name": "Heart"},
        {"id": "af_bella", "name": "Bella"},
        {"id": "af_sarah", "name": "Sarah"},
        {"id": "af_nicole", "name": "Nicole"},
    ],
    "American Male": [
        {"id": "am_adam", "name": "Adam"},
        {"id": "am_michael", "name": "Michael"},
    ],
    "British Female": [
        {"id": "bf_emma", "name": "Emma"},
        {"id": "bf_isabella", "name": "Isabella"},
    ],
    "British Male": [
        {"id": "bm_george", "name": "George"},
        {"id": "bm_lewis", "name": "Lewis"},
    ],
}

MODEL_PATH = "kokoro-v1.0.onnx"
VOICES_PATH = "voices-v1.0.bin"
LOG_FILE = "/tmp/speak_blogs.log"

tts_instance = None
tts_lock = asyncio.Lock()
# Single-thread pool — ONNX Runtime isn't thread-safe for a single session,
# but we use it to avoid blocking the event loop. Sentences within a batch
# are sequential, but we send each result immediately as it's ready.
tts_pool = ThreadPoolExecutor(max_workers=1)


async def get_tts():
    global tts_instance
    if tts_instance is None:
        async with tts_lock:
            if tts_instance is None:
                from kokoro_onnx import Kokoro
                providers = ["CPUExecutionProvider"]
                print("[tts] Loading model...", file=sys.stderr)
                session = await asyncio.to_thread(
                    rt.InferenceSession, MODEL_PATH, providers=providers
                )
                tts_instance = Kokoro.from_session(session, VOICES_PATH)
                print("[tts] Model loaded and ready", file=sys.stderr)
    return tts_instance


def generate_one(tts, text, voice, speed):
    samples, sample_rate = tts.create(text, voice=voice, speed=speed, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@app.get("/voices")
async def list_voices():
    return JSONResponse(content=VOICES)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/log")
async def log_endpoint(msg: str = ""):
    with open(LOG_FILE, "a") as f:
        f.write(msg + "\n")
    print(f"[ext] {msg}", file=sys.stderr)
    return {"ok": True}


@app.websocket("/ws")
async def websocket_tts(ws: WebSocket):
    await ws.accept()
    current_request_id = 0

    try:
        while True:
            data = await ws.receive_text()
            msg = json.loads(data)

            if msg.get("type") == "cancel":
                current_request_id += 1
                continue

            sentences = msg.get("sentences", [])
            voice = msg.get("voice", "af_heart")
            speed = max(0.5, min(2.0, msg.get("speed", 1.0)))
            start_idx = msg.get("startIndex", 0)
            request_id = msg.get("requestId", 0)

            current_request_id = request_id

            if not sentences:
                await ws.send_text(json.dumps({"type": "error", "message": "No sentences"}))
                continue

            tts = await get_tts()
            loop = asyncio.get_event_loop()

            for i, sentence in enumerate(sentences):
                # Check if this request was superseded
                if current_request_id != request_id:
                    break

                idx = start_idx + i
                text = sentence.strip()
                if not text:
                    continue

                try:
                    wav_bytes = await loop.run_in_executor(
                        tts_pool, generate_one, tts, text, voice, speed
                    )

                    if current_request_id != request_id:
                        break

                    header = struct.pack("<III", request_id, idx, len(wav_bytes))
                    await ws.send_bytes(header + wav_bytes)
                except Exception as e:
                    if current_request_id != request_id:
                        break
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "requestId": request_id,
                        "index": idx,
                        "message": str(e),
                    }))

            if current_request_id == request_id:
                await ws.send_text(json.dumps({
                    "type": "done",
                    "requestId": request_id,
                }))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7890)
