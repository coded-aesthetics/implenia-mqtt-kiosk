# Whisper.cpp Setup Guide

Server-side speech transcription for the comment dictation feature. When configured, the kiosk uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for high-quality German transcription instead of the browser-based Vosk recognizer.

**Without whisper.cpp**, dictation still works — it falls back to Vosk's open-vocabulary mode (lower accuracy for domain-specific terms).

## Quick Start

1. Install `whisper-cli` (see platform instructions below)
2. Download a model
3. Set two environment variables:

```bash
WHISPER_MODEL=/path/to/ggml-base.bin
# Optional — defaults to "whisper-cli":
# WHISPER_BIN=/path/to/whisper-cli
```

The server checks for whisper availability on startup and logs:
```
[Whisper] Found whisper-cli, model: /path/to/ggml-base.bin
```

---

## Linux

### Option A: Snap (Ubuntu, Debian, Fedora, RHEL, openSUSE)

```bash
sudo snap install whisper-cpp
```

Binary name: `whisper-cpp.cli`

```bash
WHISPER_BIN=whisper-cpp.cli
```

### Option B: AUR (Arch Linux)

```bash
yay -S whisper.cpp
# Or with NVIDIA GPU support:
yay -S whisper.cpp-cuda
```

Binary name: `whisper-cli` (installed to `/usr/bin/whisper-cli`)

### Option C: Build from Source

Dependencies (Debian/Ubuntu):
```bash
sudo apt install build-essential cmake
```

Dependencies (Fedora/RHEL):
```bash
sudo dnf install gcc-c++ cmake
```

Build:
```bash
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build -j$(nproc) --config Release
```

Binary at: `./build/bin/whisper-cli`

Install system-wide (optional):
```bash
sudo cp build/bin/whisper-cli /usr/local/bin/
```

#### GPU Acceleration (optional)

NVIDIA CUDA:
```bash
cmake -B build -DGGML_CUDA=1
cmake --build build -j$(nproc) --config Release
```

Vulkan (AMD/NVIDIA/Intel):
```bash
cmake -B build -DGGML_VULKAN=1
cmake --build build -j$(nproc) --config Release
```

---

## Windows

### Option A: Pre-built Binaries (recommended)

Download from the [latest release](https://github.com/ggml-org/whisper.cpp/releases):

| File | Description |
|------|-------------|
| `whisper-bin-x64.zip` | CPU-only, 64-bit |
| `whisper-blas-bin-x64.zip` | CPU with OpenBLAS acceleration |
| `whisper-cublas-12.4.0-bin-x64.zip` | NVIDIA CUDA 12.4 |

Extract and place `whisper-cli.exe` somewhere on PATH, or set the full path:

```
WHISPER_BIN=C:\tools\whisper-cpp\whisper-cli.exe
```

Requires [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).

### Option B: Build from Source

Requires Visual Studio 2019+ (or Build Tools) with C++ workload and CMake.

```powershell
git clone https://github.com/ggml-org/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release
```

Binary at: `build\bin\Release\whisper-cli.exe`

---

## Model Download

Models are hosted on HuggingFace. Download with `curl` or `wget`:

```bash
# Recommended for this use case (good accuracy, fast inference):
curl -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin

# Better accuracy, slower (recommended if CPU is fast enough):
curl -L -o ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

On Windows (PowerShell):
```powershell
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" -OutFile "ggml-base.bin"
```

Or use the bundled download script (if building from source):
```bash
cd whisper.cpp
sh ./models/download-ggml-model.sh base
# Downloads to models/ggml-base.bin
```

### Model Comparison

Use **non-`.en`** models — they support German.

| Model | Disk | RAM | Speed (10s clip, CPU) | Recommendation |
|-------|------|-----|----------------------|----------------|
| `ggml-tiny.bin` | 75 MB | ~273 MB | <1s | Too inaccurate for German |
| `ggml-base.bin` | 142 MB | ~388 MB | ~1-2s | **Good default** — fast, decent accuracy |
| `ggml-small.bin` | 466 MB | ~852 MB | ~3-5s | **Best balance** — good with domain terms |
| `ggml-medium.bin` | 1.5 GB | ~2.1 GB | ~8-15s | Highest accuracy, may be too slow on CPU |

For construction terminology (Suspensionsdruck, Bohrgestänge, etc.), `small` is recommended if the hardware can handle the latency.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_MODEL` | *(none — required)* | Absolute path to `ggml-*.bin` model file |
| `WHISPER_BIN` | `whisper-cli` | Path or name of the whisper.cpp CLI binary |

Example `.env`:
```bash
WHISPER_MODEL=/opt/whisper/models/ggml-base.bin
WHISPER_BIN=whisper-cli
```

---

## Verification

Test whisper-cli directly:

```bash
# Record a short WAV (requires ffmpeg or arecord):
arecord -f S16_LE -r 16000 -c 1 -d 5 test.wav

# Transcribe:
whisper-cli -m /path/to/ggml-base.bin -f test.wav -l de --no-timestamps
```

Check the server endpoint:
```bash
curl http://localhost:3000/api/transcribe/status
# {"available":true}
```

---

## Installer Integration Notes

For packaging in an auto-installer:

### Linux (systemd service / PM2)
1. Bundle `whisper-cli` binary in the release tarball, or install from snap during setup
2. Download model during first-run setup script
3. Set `WHISPER_MODEL` in the PM2 ecosystem config or `.env`

### Windows (MSI / NSIS)
1. Bundle `whisper-cli.exe` + required DLLs from the pre-built zip
2. Download model during install (or bundle `ggml-base.bin` in installer — adds 142 MB)
3. Set environment variables in the service configuration

### Model bundling considerations
- `ggml-base.bin` (142 MB) is small enough to bundle in an installer
- `ggml-small.bin` (466 MB) should be downloaded separately during setup
- Consider a first-run download with progress indicator
