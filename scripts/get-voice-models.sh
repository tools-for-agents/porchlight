#!/bin/bash
# Downloads the models jarvis (hangar's voice) runs on, once, into a fixed place:
#   ~/Library/Application Support/hangar/voice-models   (override: HANGAR_MODELS)
#
# The dir is FIXED rather than derived from --user-data-dir on purpose: a test run in a
# temp user-data-dir must not re-download 800MB, and the packaged app and `npm start`
# must agree on where the models live.
#
# Everything comes from sherpa-onnx's GitHub releases — the same project whose runtime
# is in node_modules. ~840MB down the wire, ~430MB kept on disk:
#   silero_vad.onnx                  0.6MB  — finds where speech starts and ends
#   whisper small (int8 kept)       ~250MB  — what was said, Turkish and English both
#   3d-speaker eres2net             ~40MB   — WHO said it: only the enrolled voice passes
#   piper tr_TR-dfki                ~67MB   — jarvis's OFFLINE Turkish voice, female (macOS ships no Turkish `say`)
#   piper en_US-amy                 ~67MB   — and its offline English one, also female
# (the first choice voice is Edge neural TTS over the network — these two are the fallback
#  that keeps jarvis speaking on a plane)
set -euo pipefail

DIR="${HANGAR_MODELS:-$HOME/Library/Application Support/hangar/voice-models}"
BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"
mkdir -p "$DIR"
cd "$DIR"

get() { # get <url> <target-that-proves-it-is-done>
  local url="$1" done_mark="$2"
  if [ -e "$done_mark" ]; then echo "✓ already here: $done_mark"; return 0; fi
  echo "→ $url"
  curl -fL --retry 3 -o "$(basename "$url").part" "$url"
  mv "$(basename "$url").part" "$(basename "$url")"
}

# 1. VAD
get "$BASE/asr-models/silero_vad.onnx" "silero_vad.onnx"

# 2. Whisper small — the tarball carries fp32 AND int8; only int8 + tokens are kept,
#    which is the difference between 640MB and 250MB on disk.
if [ ! -e "whisper/small-encoder.int8.onnx" ]; then
  get "$BASE/asr-models/sherpa-onnx-whisper-small.tar.bz2" "whisper/small-encoder.int8.onnx"
  tar xjf sherpa-onnx-whisper-small.tar.bz2
  mkdir -p whisper
  mv sherpa-onnx-whisper-small/small-encoder.int8.onnx whisper/
  mv sherpa-onnx-whisper-small/small-decoder.int8.onnx whisper/
  mv sherpa-onnx-whisper-small/small-tokens.txt whisper/
  rm -rf sherpa-onnx-whisper-small sherpa-onnx-whisper-small.tar.bz2
fi
echo "✓ whisper small (int8)"

# 3. Speaker embedding — trained on Chinese speakers, works on anyone: a voiceprint is a
#    voice, not a vocabulary. This is the model that makes "only my voice" true.
get "$BASE/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx" \
    "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"

# 4+5. Piper voices (both female — the owner asked for a woman's voice, so BOTH tiers are)
rm -rf vits-piper-tr_TR-fahrettin-medium vits-piper-en_US-ryan-medium   # the male pair this replaced
for v in vits-piper-tr_TR-dfki-medium vits-piper-en_US-amy-medium; do
  if [ ! -d "$v" ]; then
    get "$BASE/tts-models/$v.tar.bz2" "$v"
    tar xjf "$v.tar.bz2"
    rm -f "$v.tar.bz2"
  fi
  echo "✓ $v"
done

echo
echo "voice models ready in: $DIR"
du -sh "$DIR"
