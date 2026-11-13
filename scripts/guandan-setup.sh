#!/usr/bin/env bash
# Installs pinned upstream codec and offline export/reference dependencies into .guandan/:
#   .guandan/venv   isolated python 3.12 living room (no global installs)
#   .guandan/DanLM  pinned official dashidhy/DanLM checkout, commit-locked
#
# DanLM ships its evaluation modules as prebuilt cpython-312 extensions for darwin
# (danzero/eval/*.cpython-312-darwin.so), so the runtime must be python 3.12 on this
# machine; the weights live inside the repo itself (dansformer 47MB .pt + 2.6MB ONNX),
# which makes a pinned checkout both the source AND the checksum: `git checkout` of the
# locked commit is byte-exact, there is no separate download to verify.
#
# License note: DanLM is Apache-2.0 with additional non-commercial terms — fine for this
# local toy, not for anything commercial.
#
# Idempotent: re-running only fills in what is missing. GUANDAN_PYTHON picks the
# interpreter, GUANDAN_PIP_ARGS a custom index (e.g. a mirror).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GUANDAN_COMMIT=16ace5ada4db39086bb4c8ebb372ed16cb82fab1
GUANDAN_REPO=https://github.com/dashidhy/DanLM
VENV=.guandan/venv
SOURCE=.guandan/DanLM

echo "== pick interpreter"
# DanLM 的评估模块是 cpython-312 预编译扩展：运行时必须 Python 3.12。这份解释器"带进项目"
# （UV_PYTHON_INSTALL_DIR 指向 .guandan/pythons，gitignored），不写入 uv 的全局托管库，
# 不影响系统 Python 和其他项目。GUANDAN_PYTHON 仍可显式指定。
PY_STORE=".guandan/pythons"
PYTHON_BIN="${GUANDAN_PYTHON:-}"
if [ -z "$PYTHON_BIN" ]; then
  if [ -x "$VENV/bin/python" ]; then
    PYTHON_BIN="$VENV/bin/python"
  elif command -v python3.12 >/dev/null 2>&1; then
    PYTHON_BIN=python3.12
  elif command -v uv >/dev/null 2>&1; then
    echo "installing project-local Python 3.12 into ${ROOT}/${PY_STORE} （仅进项目，不进 uv 全局库）"
    UV_PYTHON_INSTALL_DIR="$ROOT/$PY_STORE" uv python install 3.12
    PYTHON_BIN="$(UV_PYTHON_INSTALL_DIR="$ROOT/$PY_STORE" uv python find 3.12)"
  elif command -v python3 >/dev/null 2>&1 \
      && [ "$("python3" -c 'import sys; print("%d.%d" % sys.version_info[:2])')" = "3.12" ]; then
    PYTHON_BIN=python3
  fi
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "需要 Python 3.12（export GUANDAN_PYTHON=... 指向本机 3.12，或安装 uv 后重跑本脚本）。" >&2
  echo "原因：DanLM 的评估模块是 cpython-312 预编译扩展，无法用其他版本加载。" >&2
  exit 1
fi
echo "using $PYTHON_BIN ($("$PYTHON_BIN" -V 2>&1))"

echo "== venv"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip || echo "note: pip 自升级失败（镜像限流），用 venv 现有 pip 继续" >&2
# torch ~200MB on first install; numpy + onnxruntime power the ONNX agents.
# shellcheck disable=SC2086
"$VENV/bin/pip" install --quiet ${GUANDAN_PIP_ARGS:-} torch numpy onnxruntime

echo "== pinned DanLM source ($GUANDAN_COMMIT)"
if [ ! -d "$SOURCE/.git" ]; then
  mkdir -p .guandan
  git clone --quiet --filter=blob:none --no-checkout "$GUANDAN_REPO" "$SOURCE"
fi
git -C "$SOURCE" fetch --quiet origin
git -C "$SOURCE" checkout --quiet "$GUANDAN_COMMIT"
echo "source commit $(git -C "$SOURCE" rev-parse HEAD)"

echo "== committed weights present"
for weight in ckpts/DanLM_v1/dansformer_v1_best_eval.pt ckpts/DanZero_v3_rep_v1t/v3_rep_v1t_best_eval_001_int8.onnx; do
  if [ ! -s "$SOURCE/$weight" ]; then
    echo "缺少权重 $SOURCE/$weight（checkout 不完整，删除 $SOURCE 后重跑）" >&2
    exit 1
  fi
  ls -lh "$SOURCE/$weight" | awk '{print "  " $9 " " $5}'
done

echo "== verify runtime"
"$VENV/bin/python" - << 'PY'
import sys

sys.path.insert(0, ".guandan/DanLM")
sys.path.insert(0, ".guandan/DanLM/ui")

from danzero.engine.cards import NUM_RANKS, SUIT_CHARS, TOTAL_CARD_TYPES
from danzero.engine.game import GuanDanRound
from danzero.engine.actions import play_type_of
from danzero.engine.tribute import TributeRecord, tribute_give_legal_cards

assert TOTAL_CARD_TYPES == 54, TOTAL_CARD_TYPES
assert NUM_RANKS == 13, NUM_RANKS
from ui_agent import AGENT_REGISTRY  # imports torch; heavy but the real check

expected = {"danlm_v1", "danzero_v0", "danzero_v1t"}
missing = expected - set(AGENT_REGISTRY)
assert not missing, f"agent registry缺少 {missing}"
print("danzero loads; suits order: " + "".join(SUIT_CHARS) + "; agents: " + ", ".join(sorted(AGENT_REGISTRY)))
PY

echo "== export portable CPU models"
bash scripts/ai-export.sh --game guandan
bash scripts/ai-setup.sh
echo "== done (server inference uses .ai/venv and ONNX CPU, not this Torch environment)"
