#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR=".venv"
MODEL_FILE="kokoro-v1.0.onnx"
VOICES_FILE="voices-v1.0.bin"
MODEL_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/${MODEL_FILE}"
VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/${VOICES_FILE}"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

echo "Installing dependencies..."
pip install -q -r requirements.txt

if [ ! -f "$MODEL_FILE" ]; then
    echo "Downloading Kokoro model (~300MB)..."
    curl -L -o "$MODEL_FILE" "$MODEL_URL"
fi

if [ ! -f "$VOICES_FILE" ]; then
    echo "Downloading voice pack (~5MB)..."
    curl -L -o "$VOICES_FILE" "$VOICES_URL"
fi

echo "Starting TTS server on http://127.0.0.1:7890"
python main.py
