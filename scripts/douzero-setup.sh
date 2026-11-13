#!/usr/bin/env bash
# Installs pinned DouZero source and offline export/reference weights into .douzero/:
#   .douzero/venv        isolated CPU python (no global installs)
#   .douzero/douzero-src pinned official kwai/DouZero source
#   .douzero/weights     official pretrained douzero_WP checkpoints, checksum-verified
#
# Idempotent. Re-running only fills in what is missing. The venv uses the system python3
# by default (adapts to the machine); DOUZERO_PYTHON overrides, DOUZERO_PIP_ARGS picks a
# custom index.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOUZERO_COMMIT=718a5c920bf3361e34178a38f3b80458e176b351
DOUZERO_REPO=https://github.com/kwai/DouZero
# Third-party mirror of the official release folder (the authors' Google Drive folder and the
# 百度网盘 link are the only official sources and are not scriptable; the Drive folder is gone).
MIRROR=https://huggingface.co/palemoky/douzero-baselines/resolve/main/checkpoints/douzero_WP
CROSSCHECK=https://raw.githubusercontent.com/tianqiraf/DouZero_For_HappyDouDiZhu/master/baselines/douzero_WP

VENV=.douzero/venv
SOURCE=.douzero/douzero-src
WEIGHTS=.douzero/weights/douzero_WP

echo "== pick interpreter"
# 斗地主运行时是纯源码：跟随系统的 python3（适配机器现状，不固定版本）。
# DOUZERO_PYTHON 可显式覆盖。若现有 venv 解释器版本与本机不一致，下方 venv 段会自动重建。
PYTHON_BIN="${DOUZERO_PYTHON:-python3}"
echo "using $PYTHON_BIN ($("$PYTHON_BIN" -V 2>&1))"

# sha256 of the official douzero_WP role networks. Both hosts below serve these exact bytes.
checksum_of() {
  case "$1" in
    landlord) echo 132e26479fcb69f457ddbf1ad32a7bdc3aa73cde80a28cc91f29a62c6075955a ;;
    landlord_down) echo 964720faf583f4905662c94aaf73b1a97352b76ae3686fcc949beabbacdd95d1 ;;
    landlord_up) echo b849ea518e66f088d635d3a29956da880f7b5ca89fabc5f70fc356c106ca6a15 ;;
    *) echo "unknown role $1" >&2; exit 1 ;;
  esac
}

digest() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else sha256sum "$1" | awk '{print $1}'; fi
}

echo "== venv"
if [ -d "$VENV" ] && [ -z "${DOUZERO_PYTHON:-}" ]; then
  want_minor="$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  venv_minor="$("$VENV/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null)" || venv_minor=""
  if [ ! -x "$VENV/bin/python" ]; then
    echo "venv 存在但没有可执行 python（解释器可能被系统侧清理）→ 删除重建"
    rm -rf "$VENV"
  elif [ -n "$venv_minor" ] && [ "$venv_minor" != "$want_minor" ]; then
    echo "venv 用的是 ${venv_minor}，与本机 $("$PYTHON_BIN" -V 2>&1) 不一致 → 删除重建（权重/源码在 venv 外，不受影响）"
    rm -rf "$VENV"
  fi
fi
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON_BIN" -m venv "$VENV"
fi
echo "$VENV -> $("$VENV/bin/python" -V 2>&1)"
"$VENV/bin/pip" install --quiet --upgrade pip || echo "note: pip 自升级失败（镜像限流），用 venv 现有 pip 继续" >&2
# shellcheck disable=SC2086
"$VENV/bin/pip" install --quiet ${DOUZERO_PIP_ARGS:-} -r requirements-douzero.txt

echo "== official source"
if [ ! -d "$SOURCE/.git" ]; then
  mkdir -p .douzero
  git clone --quiet "$DOUZERO_REPO" "$SOURCE"
fi
git -C "$SOURCE" fetch --quiet origin
git -C "$SOURCE" checkout --quiet "$DOUZERO_COMMIT"
echo "source commit $(git -C "$SOURCE" rev-parse HEAD)"

echo "== pretrained weights"
mkdir -p "$WEIGHTS"
for role in landlord landlord_down landlord_up; do
  target="$WEIGHTS/$role.ckpt"
  want="$(checksum_of "$role")"
  if [ -f "$target" ] && [ "$(digest "$target")" = "$want" ]; then
    echo "$role.ckpt already verified"
    continue
  fi
  curl -fsSL -o "$target.tmp" "$MIRROR/$role.ckpt"
  found="$(digest "$target.tmp")"
  if [ "$found" != "$want" ]; then
    rm -f "$target.tmp"
    echo "checksum mismatch for $role.ckpt (got $found)" >&2
    echo "official sources: README of $DOUZERO_REPO (Google Drive folder / 百度网盘, manual download)" >&2
    echo "alternative byte-identical copy: $CROSSCHECK/$role.ckpt" >&2
    exit 1
  fi
  mv "$target.tmp" "$target"
  echo "$role.ckpt verified $found"
done

echo "== export portable CPU models"
bash scripts/ai-export.sh --game douzero
bash scripts/ai-setup.sh
echo "== done"
