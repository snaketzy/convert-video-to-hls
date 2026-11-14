#!/usr/bin/env bash
#
# 源视频（本地文件或 HLS 地址）-> 进度条悬停预览缩略图（sprite / trickplay）
#
#   ffmpeg -skip_frame nokey 只解关键帧（比逐帧解码快一个数量级）
#     -> fps 抽帧 -> 等比缩放补黑边到固定格 -> tile 拼雪碧图 -> jpg
#
# 产物（<--out>/thumbnails/）：
#   tile-001.jpg …  每张 cols*rows 格，行优先排列
#   index.json      自定义索引，播放器据此把悬停时间换算到「哪张图的哪一格」
#
# 只产出旁挂资源，不改动任何 HLS 清单 / 轨道；索引缺失时播放器应静默退化为纯时间提示。
#
set -euo pipefail

FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"

INPUT=""
OUT=""
INTERVAL=10
WIDTH=160
HEIGHT=90
COLS=10
ROWS=10
QUALITY=5
LIMIT=0
DURATION=""
TONEMAP=0

usage() {
  cat <<'EOF'
用法: make_thumbnails.sh --input <视频|m3u8> --out <目录> [选项]

必填:
  --input PATH|URL       源视频文件，或 HLS master.m3u8 地址（ffmpeg 通吃）

选项:
  --out DIR              输出根目录，图集写入 <DIR>/thumbnails/
  --interval SEC         每格代表的时间跨度，默认 10
  --width PX             单格宽，默认 160
  --height PX            单格高，默认 90
                         源宽高比不一致时等比缩放后补黑边，保证网格等距
  --cols N               每行格数，默认 10
  --rows N               每列格数，默认 10
  --quality N            JPEG 质量（2 最好 31 最差），默认 5
  --limit SEC            只处理前 SEC 秒（0=全片，默认 0）
  --duration SEC         手动指定源时长，省略时用 ffprobe 探测
  --tonemap              HDR(PQ/HLG) 源转 SDR(BT.709)；不开会得到发灰的缩略图
  -h, --help             显示本帮助
EOF
}

die() { echo "错误: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    --width) WIDTH="$2"; shift 2;;
    --height) HEIGHT="$2"; shift 2;;
    --cols) COLS="$2"; shift 2;;
    --rows) ROWS="$2"; shift 2;;
    --quality) QUALITY="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    --duration) DURATION="$2"; shift 2;;
    --tonemap) TONEMAP=1; shift;;
    -h|--help) usage; exit 0;;
    *) die "未知参数: $1";;
  esac
done

[ -n "$INPUT" ] || { usage; die "缺少 --input"; }
[ -n "$OUT" ] || { usage; die "缺少 --out"; }
# 既允许本地文件，也允许 http(s) 地址（存量片子可反过来从线上 m3u8 补图，不必回炉重编）
case "$INPUT" in
  http://*|https://*) ;;
  *) [ -f "$INPUT" ] || die "输入文件不存在: $INPUT";;
esac

for bin in "$FFMPEG" "$FFPROBE"; do
  command -v "$bin" >/dev/null 2>&1 || die "找不到可执行文件: $bin"
done

for pair in "interval:$INTERVAL" "width:$WIDTH" "height:$HEIGHT" "cols:$COLS" "rows:$ROWS"; do
  case "${pair#*:}" in ''|*[!0-9]*) die "--${pair%%:*} 必须为正整数: ${pair#*:}";; esac
  [ "${pair#*:}" -gt 0 ] || die "--${pair%%:*} 必须为正整数"
done

# ---------- 源时长 ----------
# 索引用它把「时间」换算成「第几格」，必须与抽帧时的分母一致
if [ "$LIMIT" != "0" ]; then
  EFF_DUR="$LIMIT"
else
  EFF_DUR="$DURATION"
  if [ -z "$EFF_DUR" ]; then
    EFF_DUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$INPUT" | head -1)"
  fi
fi
case "$EFF_DUR" in
  ''|*[!0-9.]*) die "无法读取源时长，请用 --duration 显式指定（读到: ${EFF_DUR:-空}）";;
esac
# 格数：抽帧落在 t = 0, interval, 2*interval … 这些槽位上，槽位时间必须 < 时长。
# 这里刻意取 floor（而非 ceil）：ffmpeg 在时长边界上可能少吐一帧，
# 若声明得比实际多，末尾就会出现空格子被播放器取到黑图；少声明只会让最后
# 一个 interval 复用上一格，肉眼无感。
FRAMES="$(awk -v d="$EFF_DUR" -v i="$INTERVAL" 'BEGIN{
  n = int(d / i);
  if (n < 1) n = 1;
  printf "%d", n
}')"

THUMB_DIR="$OUT/thumbnails"
mkdir -p "$THUMB_DIR"
# 覆盖式重跑：先清掉上一轮的雪碧图，避免旧图残留被索引引用
rm -f "$THUMB_DIR"/tile-*.jpg

echo "=== 生成悬停预览缩略图 ==="
echo "  源: $INPUT"
echo "  规格: ${WIDTH}x${HEIGHT} / ${COLS}x${ROWS} 格 / 每格 ${INTERVAL}s / 共 $FRAMES 格"
echo "  输出: $THUMB_DIR"

# 用字符串而非数组：macOS 自带 bash 3.2 在 set -u 下展开空数组会报 unbound
LIMIT_ARG=""
[ "$LIMIT" = "0" ] || LIMIT_ARG="-t $LIMIT"

# HDR(PQ/HLG) 源直接转 JPEG 会得到发灰的画面，需先色调映射回 SDR(BT.709)
TM=""
if [ "$TONEMAP" = "1" ]; then
  TM="zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,"
fi

VF="fps=1/$INTERVAL,scale=$WIDTH:$HEIGHT:force_original_aspect_ratio=decrease,${TM}pad=$WIDTH:$HEIGHT:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tile=${COLS}x${ROWS}"

# -skip_frame nokey 必须在 -i 之前：它作用于解码器，只解关键帧
# 个别容器/流不标关键帧，此时该选项会一帧都吐不出来，退回逐帧解码再试一次
run_ffmpeg() {
  local skip="$1"
  # shellcheck disable=SC2086
  "$FFMPEG" -hide_banner -loglevel error -nostdin \
    $skip -i "$INPUT" \
    -an -sn -vf "$VF" \
    -q:v "$QUALITY" -f image2 $LIMIT_ARG "$THUMB_DIR/tile-%03d.jpg"
}

run_ffmpeg "-skip_frame nokey" || true
if ! ls "$THUMB_DIR"/tile-*.jpg >/dev/null 2>&1; then
  echo "  跳过关键帧无产出，退回逐帧解码重试"
  run_ffmpeg ""
fi

FILES=""
COUNT=0
for file in "$THUMB_DIR"/tile-*.jpg; do
  [ -f "$file" ] || continue
  [ "$COUNT" = "0" ] || FILES="$FILES, "
  FILES="$FILES\"$(basename "$file")\""
  COUNT=$((COUNT + 1))
done
[ "$COUNT" -gt 0 ] || die "未产出任何雪碧图，请检查源是否可解码"

DUR_TEXT="$(awk -v d="$EFF_DUR" 'BEGIN{printf "%.3f", d}')"
cat > "$THUMB_DIR/index.json" <<EOF
{
  "version": 1,
  "interval": $INTERVAL,
  "width": $WIDTH,
  "height": $HEIGHT,
  "columns": $COLS,
  "rows": $ROWS,
  "count": $FRAMES,
  "duration": $DUR_TEXT,
  "files": [$FILES]
}
EOF

echo "  完成: $COUNT 张雪碧图 + index.json"
