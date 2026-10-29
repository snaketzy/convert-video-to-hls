#!/usr/bin/env bash
#
# 本地视频 -> 多码率 / 多音轨 / 多字幕 HLS
#
#   ffmpeg(h264_videotoolbox 硬编) 产出 mezz 中间件  ->  shaka-packager 组 HLS
#
# 关键点：
#   1. 所有视频档必须同 GOP、同关键帧边界，否则切档花屏
#      VideoToolbox 默认 GOP 只有约 12 帧，必须显式给 -g 和 -force_key_frames
#   2. 音频、字幕各自独立转成 fMP4 / VTT mezz，再由 packager 合成 EXT-X-MEDIA
#   3. packager 的输入描述符必须带 in= 前缀
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
PACKAGER="${PACKAGER:-packager}"

INPUT=""
OUT=""
LADDER="240:426x240:300k:350k:700k,360:640x360:700k:800k:1500k,480:854x480:1200k:1300k:2400k,720:1280x720:2800k:3000k:5600k,1080:1920x1080:5000k:5350k:10000k"
AUDIO=""
SUBS_PREFIX=""
SUBS_LIST=""
DURATION=0
SEG=6
GOP=""
KEEP_MEZZ=0
COPY_PLAYER=1
PROGRESS=0
DEFAULT_AUDIO_LANG="en"
DEFAULT_TEXT_LANG="en"

usage() {
  cat <<'EOF'
用法: encode_hls.sh --input <视频> --out <目录> [选项]

必填:
  --input PATH           主视频文件
  --out DIR              输出根目录，内部会建 mezz/ 与 hls/

选项:
  --ladder SPEC          视频阶梯，逗号分隔，每项 name:WxH:码率:maxrate:bufsize
                         默认 240/360/480/720/1080 五档
  --audio SPEC           音轨，逗号分隔，每项 name:lang:声道数:码率:源
                         源写 main 表示取主视频第 0 条音频，否则给外挂音频文件路径
                         默认 English:en:2:192k:main
  --subs-prefix PATH     字幕前缀；匹配 <前缀>.<标签>.vtt
                         <标签> 末尾的 .default 会被去掉，并作为默认字幕
  --subs-list SPEC       字幕列表，逗号分隔，每项 标签:字幕文件路径
                         与 --subs-prefix 二选一；标签末尾的 .default 会被去掉
  --duration SEC         只处理前 SEC 秒（0=全片，默认 0）
  --segment-duration SEC 分片时长，默认 6
  --gop N                手动指定 GOP 帧数，默认按 fps*分片时长 取整
  --default-audio-lang L 默认音轨语言，默认 en
  --default-text-lang L  默认字幕语言，默认 en
  --progress             额外向 stdout 输出 ffmpeg 进度（供调用方解析），默认关闭
  --keep-mezz            打包后保留 mezz 中间文件（默认删除）
  --no-player            不复制附带播放器到 HLS 目录
  -h, --help             显示本帮助
EOF
}

die() { echo "错误: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --ladder) LADDER="$2"; shift 2;;
    --audio) AUDIO="$2"; shift 2;;
    --subs-prefix) SUBS_PREFIX="$2"; shift 2;;
    --subs-list) SUBS_LIST="$2"; shift 2;;
    --duration) DURATION="$2"; shift 2;;
    --segment-duration) SEG="$2"; shift 2;;
    --gop) GOP="$2"; shift 2;;
    --default-audio-lang) DEFAULT_AUDIO_LANG="$2"; shift 2;;
    --default-text-lang) DEFAULT_TEXT_LANG="$2"; shift 2;;
    --progress) PROGRESS=1; shift;;
    --keep-mezz) KEEP_MEZZ=1; shift;;
    --no-player) COPY_PLAYER=0; shift;;
    -h|--help) usage; exit 0;;
    *) die "未知参数: $1";;
  esac
done

[ -n "$INPUT" ] || { usage; die "缺少 --input"; }
[ -n "$OUT" ] || { usage; die "缺少 --out"; }
[ -f "$INPUT" ] || die "输入文件不存在: $INPUT"
[ -z "$SUBS_PREFIX" ] || [ -z "$SUBS_LIST" ] || die "--subs-prefix 与 --subs-list 只能二选一"

# 供调用方解析的 ffmpeg 进度输出（--progress 打开）
# 用字符串而非数组：macOS 自带 bash 3.2 在 set -u 下展开空数组会报 unbound
PARG=""
[ "$PROGRESS" = "1" ] && PARG="-progress pipe:1"

for bin in "$FFMPEG" "$FFPROBE" "$PACKAGER"; do
  command -v "$bin" >/dev/null 2>&1 || die "找不到可执行文件: $bin"
done

MEZZ="$OUT/mezz"
HLS="$OUT/hls"
mkdir -p "$MEZZ/sub" "$HLS"
MEZZ="$(cd "$MEZZ" && pwd)"
HLS="$(cd "$HLS" && pwd)"

# ---------- 探测源 ----------
FPS_RAW="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$INPUT" | head -1)"
FPS="$(awk -F/ '{printf "%.6f", ($2 ? $1/$2 : $1)}' <<<"${FPS_RAW:-0}")"
SRC_DUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$INPUT" | head -1)"
COLOR_TRC="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 "$INPUT" | head -1)"

if [ "$DURATION" = "0" ]; then DUR="$SRC_DUR"; else DUR="$DURATION"; fi
[ -n "$GOP" ] || GOP="$(awk -v f="$FPS" -v s="$SEG" 'BEGIN{printf "%d", f*s+0.5}')"

# HDR(PQ/HLG) 源 -> SDR(BT.709) 的色调映射链
# 先 scale 再 tonemap：zscale/tonemap 的像素量按目标档位计，4K 源上直接做会非常慢
HDR2SDR=""
case "${COLOR_TRC:-}" in
  smpte2084 | arib-std-b67)
    HDR2SDR="zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
    ;;
esac

# 硬件解码：4K HEVC 软解是这条流水线的真正瓶颈，VideoToolbox 解码后仍回落到系统内存
# 供 CPU 滤镜与硬编使用；HWACCEL=0 可强制软解做对比
HWACCEL="${HWACCEL:-1}"
HWARG=""
if [ "$HWACCEL" = "1" ]; then HWARG="-hwaccel videotoolbox"; fi

echo "源         : $INPUT"
echo "帧率       : $FPS  (GOP=$GOP, 分片=${SEG}s)"
echo "处理时长   : ${DUR}s"
echo "色彩       : ${COLOR_TRC:-unknown}  (HDR->SDR: $([ -n "$HDR2SDR" ] && echo 开 || echo 关))"
echo "解码       : $([ "$HWACCEL" = "1" ] && echo videotoolbox 硬解 || echo 软解)"
echo "mezz       : $MEZZ"
echo "hls        : $HLS"
echo

# ---------- 1. 视频档 ----------
# 一次解码源，filter_complex 把解码帧 split 给 N 条 scale(+tonemap) 链，再并发输出 N 档。
# 若每档各起一个 ffmpeg，4K HEVC 源会被完整解码 N 遍，而解码占单档耗时约 87%：
# 60s 素材实测 5 档串行 41.3s -> 单进程并发 16.6s（约 2.5x），产物帧数/时长/关键帧完全一致。
echo "=== 1/4 视频编码 (硬编 $FFMPEG h264_videotoolbox) ==="
IFS=',' read -r -a LADDER_ITEMS <<<"$LADDER"
LADDER_N="${#LADDER_ITEMS[@]}"
# 进度按「视频阶段=1 项」上报，故只在这里打一条条目行；各档明细用日志前缀，不参与计数
echo "  - 视频 ${LADDER_N} 档并发输出"

FC=""
VOUT_ARGS=()
VI=0
for item in "${LADDER_ITEMS[@]}"; do
  IFS=':' read -r vname vsize vbr vmax vbuf <<<"$item"
  [ -n "${vname:-}" ] && [ -n "${vsize:-}" ] || die "阶梯格式错误: $item"
  echo "  · $vname ($vsize, $vbr)"
  VI=$((VI + 1))
  # SDR 源只缩放；HDR 源在缩放后补一段 BT.2020 PQ -> BT.709 的色调映射
  VF="scale=$vsize:flags=bicubic"
  [ -n "$HDR2SDR" ] && VF="$VF,$HDR2SDR"
  if [ "$VI" = "1" ]; then
    FC="[0:v]split=$LADDER_N"
    s=0
    while [ "$s" -lt "$LADDER_N" ]; do FC="$FC[v$s]"; s=$((s + 1)); done
    FC="$FC;"
  fi
  FC="$FC[v$((VI - 1))]$VF[o$VI];"
  VOUT_ARGS+=(-map "[o$VI]" -c:v h264_videotoolbox -profile:v high -pix_fmt yuv420p \
    -b:v "$vbr" -maxrate "$vmax" -bufsize "$vbuf" -g "$GOP" \
    -force_key_frames "expr:gte(t,n_forced*$SEG)" -movflags +faststart \
    "$MEZZ/v_$vname.mp4")
done
FC="${FC%;}"

"$FFMPEG" -y -hide_banner -loglevel error -nostats $PARG $HWARG -t "$DUR" -i "$INPUT" -an \
  -filter_complex "$FC" "${VOUT_ARGS[@]}"

# ---------- 2. 音轨 ----------
echo "=== 2/4 音频编码 ==="
[ -n "$AUDIO" ] || AUDIO="English:en:2:192k:main"
IFS=',' read -r -a AUDIO_ITEMS <<<"$AUDIO"
for item in "${AUDIO_ITEMS[@]}"; do
  IFS=':' read -r aname alang ach abr asrc <<<"$item"
  [ -n "${aname:-}" ] && [ -n "${asrc:-}" ] || die "音轨格式错误: $item"
  slug="$(printf '%s' "$aname" | tr -c 'A-Za-z0-9_-' '_')"
  ch_args=(-ac "$ach")
  [ "$ach" = "6" ] && ch_args=(-ac 6 -channel_layout 5.1)
  echo "  - $aname ($alang, ${ach}ch, $abr, 源=$asrc)"
  if [ "$asrc" = "main" ]; then
    "$FFMPEG" -y -hide_banner -loglevel error -nostats $PARG -t "$DUR" -i "$INPUT" -map 0:a:0 \
      -c:a aac -b:a "$abr" "${ch_args[@]}" "$MEZZ/a_$slug.mp4"
  else
    [ -f "$asrc" ] || die "外挂音轨不存在: $asrc"
    "$FFMPEG" -y -hide_banner -loglevel error -nostats $PARG -t "$DUR" -i "$asrc" \
      -c:a aac -b:a "$abr" "${ch_args[@]}" "$MEZZ/a_$slug.mp4"
  fi
done

# ---------- 3. 字幕 ----------
echo "=== 3/4 字幕准备 ==="
SUBS=()
SUBS_N=0
if [ -n "$SUBS_LIST" ]; then
  IFS=',' read -r -a SUB_ITEMS <<<"$SUBS_LIST"
  for entry in "${SUB_ITEMS[@]}"; do
    [ -n "$entry" ] || continue
    label="${entry%%:*}"
    sfile="${entry#*:}"
    [ "$label" != "$sfile" ] || die "字幕条目格式错误（应为 标签:文件）: $entry"
    [ -f "$sfile" ] || die "字幕文件不存在: $sfile"
    label="${label%.default}"
    slug="$(sed 's/[()]//g; s/ /_/g' <<<"$label")"
    python3 "$SCRIPT_DIR/trim_vtt.py" "$sfile" "$MEZZ/sub/$slug.vtt" "$DUR"
    SUBS+=("$slug|$label")
    SUBS_N=$((SUBS_N + 1))
  done
  [ "$SUBS_N" -gt 0 ] || die "--subs-list 未解析出任何字幕"
  echo "  共 $SUBS_N 条字幕（--subs-list）"
elif [ -n "$SUBS_PREFIX" ]; then
  shopt -s nullglob
  pbase="$(basename "$SUBS_PREFIX")"
  for f in "$SUBS_PREFIX".*.vtt; do
    base="$(basename "$f" .vtt)"
    label="${base:$(( ${#pbase} + 1 ))}"
    label="${label%.default}"
    slug="$(sed 's/[()]//g; s/ /_/g' <<<"$label")"
    python3 "$SCRIPT_DIR/trim_vtt.py" "$f" "$MEZZ/sub/$slug.vtt" "$DUR"
    SUBS+=("$slug|$label")
    SUBS_N=$((SUBS_N + 1))
  done
  shopt -u nullglob
  [ "$SUBS_N" -gt 0 ] || die "没有匹配到字幕: $SUBS_PREFIX.*.vtt"
  echo "  共 $SUBS_N 条字幕"
else
  echo "  未指定 --subs-prefix / --subs-list，跳过字幕"
fi

# 字幕/音轨显示名 -> BCP-47 语言码
# 匹配规则：转小写后精确匹配（大小写不敏感）
# 必须与 server/src/lib/languages.js 的 LANGUAGE_LABELS 保持一致
lang_of() {
  local key
  key="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$key" in
    arabic) echo "ar";;
    bulgarian) echo "bg";;
    cantonese) echo "yue";;
    chinese) echo "zh";;
    "chinese (cantonese)") echo "yue";;
    "chinese (simplified)") echo "zh-Hans";;
    "chinese (traditional)") echo "zh-Hant";;
    croatian) echo "hr";;
    czech) echo "cs";;
    danish) echo "da";;
    dutch) echo "nl";;
    english) echo "en";;
    estonian) echo "et";;
    finnish) echo "fi";;
    french) echo "fr";;
    "french (canada)") echo "fr-CA";;
    "french (canada)-2") echo "fr-CA";;
    "french (france)") echo "fr-FR";;
    "french (parisian)") echo "fr-FR";;
    german) echo "de";;
    greek) echo "el";;
    hebrew) echo "he";;
    hungarian) echo "hu";;
    icelandic) echo "is";;
    italian) echo "it";;
    japanese) echo "ja";;
    korean) echo "ko";;
    latvian) echo "lv";;
    lithuanian) echo "lt";;
    mandarin) echo "zh";;
    norwegian) echo "nb";;
    polish) echo "pl";;
    portuguese) echo "pt";;
    "portuguese (brazil)") echo "pt-BR";;
    "portuguese (iberian)") echo "pt-PT";;
    romanian) echo "ro";;
    russian) echo "ru";;
    slovak) echo "sk";;
    slovenian) echo "sl";;
    spanish) echo "es";;
    "spanish (castilian)") echo "es-ES";;
    "spanish (latin america)") echo "es-419";;
    "spanish (spain)") echo "es-ES";;
    swedish) echo "sv";;
    thai) echo "th";;
    "traditional chinese") echo "zh-Hant";;
    "traditional chinese(hk)") echo "zh-Hant-HK";;
    turkish) echo "tr";;
    ukrainian) echo "uk";;
    vietnamese) echo "vi";;
    *) echo "";;
  esac
}

# ---------- 4. 打包 ----------
echo "=== 4/4 shaka-packager 组 HLS ==="
cd "$HLS"
rm -rf master.m3u8 v_* a_* s_*

DESC=()
for item in "${LADDER_ITEMS[@]}"; do
  IFS=':' read -r vname _ _ _ _ <<<"$item"
  DESC+=("in=../mezz/v_$vname.mp4,stream=video,init_segment=$vname/init.mp4,segment_template=$vname/\$Number\$.m4s,playlist_name=$vname/playlist.m3u8")
done

for item in "${AUDIO_ITEMS[@]}"; do
  IFS=':' read -r aname alang _ _ _ <<<"$item"
  slug="$(printf '%s' "$aname" | tr -c 'A-Za-z0-9_-' '_')"
  desc="in=../mezz/a_$slug.mp4,stream=audio,init_segment=a_$slug/init.mp4,segment_template=a_$slug/\$Number\$.m4s,playlist_name=a_$slug/playlist.m3u8,hls_group_id=audio,hls_name=$aname"
  # packager 会直接拒绝 lang=und；语言未知时不带 lang=（该轨也就无法成为默认轨）
  if [ -n "$alang" ] && [ "$alang" != "und" ]; then desc="$desc,lang=$alang"; fi
  DESC+=("$desc")
done

if [ "$SUBS_N" -gt 0 ]; then
  for entry in "${SUBS[@]}"; do
    slug="${entry%%|*}"; label="${entry##*|}"
    lang="$(lang_of "$label")"
    desc="in=../mezz/sub/$slug.vtt,stream=text,segment_template=s_$slug/\$Number\$.vtt,playlist_name=s_$slug/playlist.m3u8,hls_group_id=subs,hls_name=$label"
    [ -n "$lang" ] && desc="$desc,lang=$lang"
    DESC+=("$desc")
  done
fi

echo "  输入流数量: ${#DESC[@]}"
"$PACKAGER" "${DESC[@]}" \
  --segment_duration "$SEG" \
  --default_language "$DEFAULT_AUDIO_LANG" \
  --default_text_language "$DEFAULT_TEXT_LANG" \
  --hls_master_playlist_output master.m3u8

# ---------- 附带播放器 ----------
if [ "$COPY_PLAYER" = "1" ] && [ -f "$SKILL_DIR/assets/player.html" ]; then
  cp "$SKILL_DIR/assets/player.html" "$HLS/player.html"
  if [ ! -f "$HLS/hls.min.js" ]; then
    echo
    echo "提示: 播放器需要同目录的 hls.min.js，执行下面命令补齐："
    echo "  curl -fsSL -o \"$HLS/hls.min.js\" https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"
  fi
fi

# ---------- 校验 ----------
echo
echo "=== 分段核对 ==="
for item in "${LADDER_ITEMS[@]}"; do
  IFS=':' read -r vname _ _ _ _ <<<"$item"
  printf "  v_%-6s %s 段\n" "$vname" "$(ls "$vname"/*.m4s 2>/dev/null | wc -l | tr -d ' ')"
done
for item in "${AUDIO_ITEMS[@]}"; do
  IFS=':' read -r aname _ _ _ _ <<<"$item"
  slug="$(printf '%s' "$aname" | tr -c 'A-Za-z0-9_-' '_')"
  printf "  a_%-6s %s 段\n" "$slug" "$(ls "a_$slug"/*.m4s 2>/dev/null | wc -l | tr -d ' ')"
done
[ "$SUBS_N" -gt 0 ] && echo "  字幕轨 $SUBS_N 条"

echo
echo "=== 关键帧对齐（各档前 3 个）==="
for item in "${LADDER_ITEMS[@]}"; do
  IFS=':' read -r vname _ _ _ _ <<<"$item"
  printf "  v_%-6s " "$vname"
  "$FFPROBE" -v error -select_streams v:0 -skip_frame nokey \
    -show_entries frame=pts_time -of csv=p=0 -read_intervals "%+$((SEG * 3))" \
    "$MEZZ/v_$vname.mp4" 2>/dev/null | head -3 | tr '\n' ' '
  echo
done

if [ "$KEEP_MEZZ" = "0" ]; then
  rm -rf "$MEZZ"
  echo
  echo "已删除 mezz 中间文件（--keep-mezz 可保留）"
fi

echo
echo "完成。master 播放列表: $HLS/master.m3u8"
