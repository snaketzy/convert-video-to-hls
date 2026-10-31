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
# 两条独立阶梯，一次解码后并发输出：HEVC 覆盖 2160->360，H.264 覆盖 1080->360
# 把某条置空（--ladder-hevc ""）即可只产出另一条
# 规格里的 WxH 是「档位框」上限：实际按源宽高比等比缩到框内再补黑边，
# 档位框高于源分辨率的档会整档跳过（绝不放大）
LADDER_HEVC="2160:3840x2160:12000k:13000k:24000k,1080:1920x1080:4000k:4200k:8000k,720:1280x720:2200k:2400k:4400k,480:854x480:900k:1000k:1800k,360:640x360:500k:600k:1000k"
LADDER_H264="1080:1920x1080:5000k:5350k:10000k,720:1280x720:2800k:3000k:5600k,480:854x480:1200k:1300k:2400k,360:640x360:700k:800k:1500k"
HLS_HEVC=""
HLS_H264=""
AUDIO=""
SUBS_PREFIX=""
SUBS_LIST=""
PGS_LIST=""
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
  --ladder-hevc SPEC     HEVC 阶梯，逗号分隔，每项 name:WxH:码率:maxrate:bufsize
                         默认 2160/1080/720/480/360 五档；置空则跳过 HEVC 这条
  --ladder-h264 SPEC     H.264 阶梯，格式同上
                         默认 1080/720/480/360 四档；置空则跳过 H.264 这条
                         两条阶梯一次解码并发输出，各自写入 <out>/HEVC 与 <out>/H264
                         WxH 是档位框上限：按源宽高比等比缩到框内后补黑边（方形像素），
                         档位框高于源分辨率的档会自动跳过
  --audio SPEC           音轨，逗号分隔，每项 name:lang:声道数:码率:源
                         源写 main 表示取主视频第 0 条音频，否则给外挂音频文件路径
                         默认 English:en:2:192k:main
  --subs-prefix PATH     字幕前缀；匹配 <前缀>.<标签>.vtt
                         <标签> 末尾的 .default 会被去掉，并作为默认字幕
  --subs-list SPEC       字幕列表，逗号分隔，每项 标签:字幕文件路径
                         与 --subs-prefix 二选一；标签末尾的 .default 会被去掉
  --pgs-list SPEC        PGS 位图字幕（.sup）列表，逗号分隔，每项 名称:语言码:源
                         源写 main#N 取主视频第 N 条字幕流（0 起，须为 hdmv_pgs_subtitle），
                         否则给外挂 .sup 文件路径
                         抽出的 .sup 以 <语言码>.sup 写进每条阶梯的 pgs-subs/，
                         并生成 pgs-subs/index.json（与 hls.min.js 平级）
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
    --ladder-hevc) LADDER_HEVC="$2"; shift 2;;
    --ladder-h264) LADDER_H264="$2"; shift 2;;
    --audio) AUDIO="$2"; shift 2;;
    --subs-prefix) SUBS_PREFIX="$2"; shift 2;;
    --subs-list) SUBS_LIST="$2"; shift 2;;
    --pgs-list) PGS_LIST="$2"; shift 2;;
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
mkdir -p "$MEZZ/sub"
MEZZ="$(cd "$MEZZ" && pwd)"

# 两条阶梯各自一个输出目录，只创建实际会用到的（置空的那条不建目录）
if [ -n "$LADDER_HEVC" ]; then
  mkdir -p "$OUT/HEVC"
  HLS_HEVC="$(cd "$OUT/HEVC" && pwd)"
fi
if [ -n "$LADDER_H264" ]; then
  mkdir -p "$OUT/H264"
  HLS_H264="$(cd "$OUT/H264" && pwd)"
fi
[ -n "$HLS_HEVC$HLS_H264" ] || die "两条阶梯都为空，没有可编码的档位"

# ---------- 探测源 ----------
FPS_RAW="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$INPUT" | head -1)"
FPS="$(awk -F/ '{printf "%.6f", ($2 ? $1/$2 : $1)}' <<<"${FPS_RAW:-0}")"
SRC_DUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$INPUT" | head -1)"
COLOR_TRC="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=color_transfer -of csv=p=0 "$INPUT" | head -1)"
# 源画面几何：像素宽高 SRC_W x SRC_H，以及像素宽高比 SAR（形如 4:3 / 32:27）
SRC_W="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$INPUT" | head -1)"
SRC_H="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$INPUT" | head -1)"
SRC_SAR="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=sample_aspect_ratio -of csv=p=0 "$INPUT" | head -1)"

if [ "$DURATION" = "0" ]; then DUR="$SRC_DUR"; else DUR="$DURATION"; fi
[ -n "$GOP" ] || GOP="$(awk -v f="$FPS" -v s="$SEG" 'BEGIN{printf "%d", f*s+0.5}')"

# 方形像素等效显示尺寸：SAR 只作用于宽（dw = 宽 × SAR，dh = 高）。
# SAR 缺失 / 0:1 / N/A 一律当方形像素，避免把正常源算变形。
read -r SRC_DW SRC_DH <<<"$(awk -v w="${SRC_W:-0}" -v h="${SRC_H:-0}" -v sar="${SRC_SAR:-}" 'BEGIN{
  n = 1; d = 1;
  if (sar ~ /^[0-9]+:[0-9]+$/) { split(sar, p, ":"); if (p[1] + 0 > 0 && p[2] + 0 > 0) { n = p[1]; d = p[2]; } }
  printf "%.4f %.4f", w * n / d, h
}')"
[ "${SRC_DW%%.*}" -gt 0 ] 2>/dev/null && [ "${SRC_DH%%.*}" -gt 0 ] 2>/dev/null \
  || die "无法从源读取画面尺寸，无法按源分辨率裁剪档位"

# 把档位框等比缩小到源宽高比之内，输出「内容宽 内容高 是否需要放大(1=是)」
# 需要放大 = 源填不满档位框（如 1080p 源遇到 2160 档），调用方据此整档跳过。
# 容忍 ≤5% 的轻微放大：源常见 1918x1080 / 1912x1072 这类近似分辨率，不该因此掉档。
fit_to_box() {
  local bw="${1%x*}" bh="${1#*x}"
  case "$bw$bh" in ''|*[!0-9]*) die "阶梯格式错误，档位框应为 WxH: $1";; esac
  awk -v dw="$SRC_DW" -v dh="$SRC_DH" -v bw="$bw" -v bh="$bh" 'BEGIN{
    f1 = bw / dw; f2 = bh / dh; f = (f1 < f2 ? f1 : f2);
    cw = int(dw * f / 2 + 0.5) * 2; ch = int(dh * f / 2 + 0.5) * 2;
    if (cw > bw) cw = bw - (bw % 2); if (ch > bh) ch = bh - (bh % 2);
    if (cw < 2) cw = 2; if (ch < 2) ch = 2;
    # 结尾换行不能省：read 在无换行时会返回非 0，set -e 下会静默中止脚本
    printf "%d %d %d\n", cw, ch, (f > 1.05 ? 1 : 0)
  }'
}

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
echo "源画面     : ${SRC_W}x${SRC_H}  SAR=${SRC_SAR:-1:1}  (方形像素等效 ${SRC_DW%%.*}x${SRC_DH%%.*})"
echo "处理时长   : ${DUR}s"
echo "色彩       : ${COLOR_TRC:-unknown}  (HDR->SDR: $([ -n "$HDR2SDR" ] && echo 开 || echo 关))"
echo "解码       : $([ "$HWACCEL" = "1" ] && echo videotoolbox 硬解 || echo 软解)"
echo "mezz       : $MEZZ"
if [ -n "$HLS_HEVC" ]; then echo "HEVC 输出  : $HLS_HEVC"; fi
if [ -n "$HLS_H264" ]; then echo "H264 输出  : $HLS_H264"; fi
echo

# ---------- 1. 视频档 ----------
# 一次解码源，filter_complex 把解码帧 split 给 N 条 scale(+tonemap) 链，再并发输出 N 档。
# 若每档各起一个 ffmpeg，4K HEVC 源会被完整解码 N 遍，而解码占单档耗时约 87%：
# 60s 素材实测 5 档串行 41.3s -> 单进程并发 16.6s（约 2.5x），产物帧数/时长/关键帧完全一致。
#
# 每档先把画面按源宽高比等比缩到档位框内，再补黑边填满档位框（方形像素）：
# 1920x800 / 1440x1080 / 2.39:1 这类非 16:9 源既不会变形，也不会被裁切。
echo "=== 1/4 视频编码 (硬编 videotoolbox) ==="

# 按源分辨率裁剪两条阶梯：整档高于源分辨率的直接剔除（绝不放大）
# stdout 只回传筛选结果（被命令替换捕获），跳过说明一律走 stderr
prune_ladder() {  # $1=标签  $2=阶梯规格 -> stdout 输出保留的规格
  local label="$1" spec="$2" item vname vsize cw ch up out=""
  local -a items=()
  IFS=',' read -r -a items <<<"$spec"
  for item in "${items[@]}"; do
    IFS=':' read -r vname vsize _ _ _ <<<"$item"
    read -r cw ch up < <(fit_to_box "$vsize")
    if [ "$up" = "1" ]; then
      echo "  · 跳过 ${label} ${vname}（档位框 ${vsize} 高于源画面，放大无意义）" >&2
    else
      out="${out:+$out,}$item"
    fi
  done
  printf '%s' "$out"
}
# 注意：prune_ladder 在子 shell 里执行，只是把筛选结果回传，阶梯变量在父 shell 里赋值
if [ -n "$LADDER_HEVC" ]; then LADDER_HEVC="$(prune_ladder HEVC "$LADDER_HEVC")"; fi
if [ -n "$LADDER_H264" ]; then LADDER_H264="$(prune_ladder 'H.264' "$LADDER_H264")"; fi

# 整条阶梯被裁空时撤掉它的输出目录与变量，避免留下空目录
if [ -z "$LADDER_HEVC" ] && [ -n "$HLS_HEVC" ]; then
  rm -rf "$HLS_HEVC"; HLS_HEVC=""
  echo "  · HEVC 阶梯没有可用档位，跳过该阶梯"
fi
if [ -z "$LADDER_H264" ] && [ -n "$HLS_H264" ]; then
  rm -rf "$HLS_H264"; HLS_H264=""
  echo "  · H.264 阶梯没有可用档位，跳过该阶梯"
fi
[ -n "$HLS_HEVC$HLS_H264" ] || die "源画面 ${SRC_W}x${SRC_H} 低于最低档位，没有可编码的档位"

HEVC_ITEMS=()
H264_ITEMS=()
if [ -n "$LADDER_HEVC" ]; then IFS=',' read -r -a HEVC_ITEMS <<<"$LADDER_HEVC"; fi
if [ -n "$LADDER_H264" ]; then IFS=',' read -r -a H264_ITEMS <<<"$LADDER_H264"; fi
HEVC_N="${#HEVC_ITEMS[@]}"
H264_N="${#H264_ITEMS[@]}"
LADDER_N=$((HEVC_N + H264_N))
# 进度按「视频阶段=1 项」上报，故只在这里打一条条目行；各档明细用日志前缀，不参与计数
echo "  - 视频 ${LADDER_N} 档并发输出（HEVC ${HEVC_N} 档 + H.264 ${H264_N} 档）"

FC="[0:v]split=$LADDER_N"
s=0
while [ "$s" -lt "$LADDER_N" ]; do FC="$FC[v$s]"; s=$((s + 1)); done
FC="$FC;"

VOUT_ARGS=()
VI=0
# HEVC 阶梯
if [ "$HEVC_N" -gt 0 ]; then
  for item in "${HEVC_ITEMS[@]}"; do
    IFS=':' read -r vname vsize vbr vmax vbuf <<<"$item"
    [ -n "${vname:-}" ] && [ -n "${vsize:-}" ] || die "阶梯格式错误: $item"
    # 等比缩到档位框内并置方形像素；HDR 源在缩放后补色调映射；黑边最后补在色调映射之后
    read -r cw ch _up < <(fit_to_box "$vsize")
    echo "  · HEVC $vname ($vsize 框 -> ${cw}x${ch}, $vbr)"
    VF="scale=$cw:$ch:flags=bicubic,setsar=1"
    if [ -n "$HDR2SDR" ]; then VF="$VF,$HDR2SDR"; fi
    VF="$VF,pad=${vsize%x*}:${vsize#*x}:(ow-iw)/2:(oh-ih)/2:color=black"
    FC="$FC[v$VI]$VF[o$VI];"
    VOUT_ARGS+=(-map "[o$VI]" -c:v hevc_videotoolbox -tag:v hvc1 -pix_fmt yuv420p \
      -b:v "$vbr" -maxrate "$vmax" -bufsize "$vbuf" -g "$GOP" \
      -force_key_frames "expr:gte(t,n_forced*$SEG)" -movflags +faststart \
      "$MEZZ/v_hevc_$vname.mp4")
    VI=$((VI + 1))
  done
fi
# H.264 阶梯
if [ "$H264_N" -gt 0 ]; then
  for item in "${H264_ITEMS[@]}"; do
    IFS=':' read -r vname vsize vbr vmax vbuf <<<"$item"
    [ -n "${vname:-}" ] && [ -n "${vsize:-}" ] || die "阶梯格式错误: $item"
    read -r cw ch _up < <(fit_to_box "$vsize")
    echo "  · H.264 $vname ($vsize 框 -> ${cw}x${ch}, $vbr)"
    VF="scale=$cw:$ch:flags=bicubic,setsar=1"
    if [ -n "$HDR2SDR" ]; then VF="$VF,$HDR2SDR"; fi
    VF="$VF,pad=${vsize%x*}:${vsize#*x}:(ow-iw)/2:(oh-ih)/2:color=black"
    FC="$FC[v$VI]$VF[o$VI];"
    VOUT_ARGS+=(-map "[o$VI]" -c:v h264_videotoolbox -profile:v high -pix_fmt yuv420p \
      -b:v "$vbr" -maxrate "$vmax" -bufsize "$vbuf" -g "$GOP" \
      -force_key_frames "expr:gte(t,n_forced*$SEG)" -movflags +faststart \
      "$MEZZ/v_h264_$vname.mp4")
    VI=$((VI + 1))
  done
fi
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
# 匹配规则：显示名 trim 后精确匹配（大小写不敏感）
# 显示名查不到时，若该串本身就是形似 BCP-47 的语言码（如 en、zh-Hans、fr-CA）则原样使用；und 视为未知
# 必须与 server/src/lib/languages.js 的 LANGUAGE_LABELS / langOfName 保持一致
lang_of() {
  local raw key
  raw="$(printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  key="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
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
    # 语言码别名：可直接用编码侧的语言码作为轨道名
    "zh-cn") echo "zh-Hans";;
    "zh-tw") echo "zh-Hant";;
    "zh-hk") echo "zh-Hant-HK";;
    "zh-hans") echo "zh-Hans";;
    "zh-hant") echo "zh-Hant";;
    "zh-hant-hk") echo "zh-Hant-HK";;
    "zh_cn") echo "zh-Hans";;
    "zh_tw") echo "zh-Hant";;
    "zh_hk") echo "zh-Hant-HK";;
    *)
      # 显示名查不到：本身形似 BCP-47 的语言码则原样输出；und 视为未知
      if [ "$key" != "und" ] && printf '%s' "$raw" | grep -Eq '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'; then
        printf '%s' "$raw"
      fi
      ;;
  esac
}

# ---------- PGS 位图字幕（.sup） ----------
# 先抽到 mezz/pgs/，打包后再写进每条阶梯的 pgs-subs/（与 hls.min.js 平级）
# PGS_ROWS 每行: 语言码|名称|文件名|mezz序号；用换行分隔的字符串而非数组：bash 3.2 + set -u 展开空数组会报错
PGS_ROWS=""
PGS_FILES=""
PGS_N=0
if [ -n "$PGS_LIST" ]; then
  mkdir -p "$MEZZ/pgs"
  # 只编码前 N 秒时把 .sup 一起裁齐，保证样片自洽；全片则原样保留（外挂 .sup 直接无损复制）
  PGS_TRIM=""
  if [ "$DURATION" -gt 0 ]; then PGS_TRIM="-t $DUR"; fi
  IFS=',' read -r -a PGS_ITEMS <<<"$PGS_LIST"
  pgs_i=0
  for entry in "${PGS_ITEMS[@]}"; do
    [ -n "$entry" ] || continue
    pname="${entry%%:*}"
    pre="${entry#*:}"
    plang="${pre%%:*}"
    psrc="${pre#*:}"
    [ "$pre" != "$psrc" ] || die "PGS 条目格式错误（应为 名称:语言码:源）: $entry"
    pout="$MEZZ/pgs/$pgs_i.sup"
    case "$psrc" in
      main#*)
        pord="${psrc#main#}"
        case "$pord" in ''|*[!0-9]*) die "PGS 内嵌轨序号非法: $entry";; esac
        # shellcheck disable=SC2086
        "$FFMPEG" -y -hide_banner -loglevel error -nostats $PGS_TRIM -i "$INPUT" \
          -map "0:s:$pord" -c:s copy -f sup "$pout" || die "抽取内嵌 PGS 失败: $entry"
        ;;
      *)
        [ -f "$psrc" ] || die "PGS 文件不存在: $psrc"
        # shellcheck disable=SC2086
        "$FFMPEG" -y -hide_banner -loglevel error -nostats $PGS_TRIM -f sup -i "$psrc" \
          -c:s copy -f sup "$pout" || die "抽取 PGS 失败: $psrc"
        ;;
    esac
    # 文件名用语言码；语言码缺失时退回 und；重名追加 -2 / -3 ...
    plang="${plang:-und}"
    pbase="$(printf '%s' "$plang" | tr -c 'A-Za-z0-9._-' '_')"
    [ -n "$pbase" ] || pbase="pgs$pgs_i"
    pfile="$pbase.sup"; pn=2
    while printf '%s\n' "$PGS_FILES" | grep -qxF "$pfile"; do
      pfile="$pbase-$pn.sup"; pn=$((pn + 1))
    done
    PGS_FILES="${PGS_FILES}${pfile}"$'\n'
    PGS_ROWS="${PGS_ROWS}${plang}|${pname}|${pfile}|${pgs_i}"$'\n'
    PGS_N=$((PGS_N + 1))
    pgs_i=$((pgs_i + 1))
  done
  echo "  · PGS 位图字幕 $PGS_N 条"
fi

# ---------- 4. 打包 ----------
echo "=== 4/4 shaka-packager 组 HLS ==="

# 同一批音轨/字幕 mezz 复用到两条阶梯，各自打包进自己的输出目录
pack_into() {  # $1=codec(hevc|h264)  $2=输出目录  其余=视频档位规格
  local codec="$1" dir="$2"
  shift 2
  local items=("$@")
  local DESC item vname aname alang slug desc label lang entry
  mkdir -p "$dir"
  cd "$dir"
  rm -rf master.m3u8 v_* a_* s_*

  DESC=()
  for item in "${items[@]}"; do
    IFS=':' read -r vname _ _ _ _ <<<"$item"
    DESC+=("in=../mezz/v_${codec}_$vname.mp4,stream=video,init_segment=$vname/init.mp4,segment_template=$vname/\$Number\$.m4s,playlist_name=$vname/playlist.m3u8")
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
      if [ -n "$lang" ]; then desc="$desc,lang=$lang"; fi
      DESC+=("$desc")
    done
  fi

  echo "  [$codec] 输入流数量: ${#DESC[@]}"
  "$PACKAGER" "${DESC[@]}" \
    --segment_duration "$SEG" \
    --default_language "$DEFAULT_AUDIO_LANG" \
    --default_text_language "$DEFAULT_TEXT_LANG" \
    --hls_master_playlist_output master.m3u8
}

if [ "$HEVC_N" -gt 0 ]; then pack_into hevc "$HLS_HEVC" "${HEVC_ITEMS[@]}"; fi
if [ "$H264_N" -gt 0 ]; then pack_into h264 "$HLS_H264" "${H264_ITEMS[@]}"; fi

# ---------- PGS 字幕落盘 ----------
# 每条阶梯目录下建 pgs-subs/（与 hls.min.js 平级）：<语言码>.sup + index.json
write_pgs_subs() {  # $1=HLS 输出目录
  local dir="$1" json="[" first=1 lang name file idx
  [ "$PGS_N" -gt 0 ] || return 0
  mkdir -p "$dir/pgs-subs"
  while IFS='|' read -r lang name file idx; do
    [ -n "$file" ] || continue
    cp "$MEZZ/pgs/$idx.sup" "$dir/pgs-subs/$file"
    # JSON 里不能出现裸引号 / 反斜杠
    name="${name//\\/}"
    name="${name//\"/}"
    if [ "$first" = "1" ]; then first=0; else json="$json,"; fi
    json="$json
  { \"lang\": \"$lang\", \"name\": \"$name\", \"file\": \"$file\" }"
  done <<<"$PGS_ROWS"
  printf '%s\n]\n' "$json" > "$dir/pgs-subs/index.json"
}

if [ "$PGS_N" -gt 0 ]; then
  if [ -n "$HLS_HEVC" ]; then write_pgs_subs "$HLS_HEVC"; fi
  if [ -n "$HLS_H264" ]; then write_pgs_subs "$HLS_H264"; fi
fi

# ---------- 附带播放器 ----------
if [ "$COPY_PLAYER" = "1" ] && [ -f "$SKILL_DIR/assets/player.html" ]; then
  for dir in "$HLS_HEVC" "$HLS_H264"; do
    [ -n "$dir" ] || continue
    cp "$SKILL_DIR/assets/player.html" "$dir/player.html"
    # 播放器靠同目录的 hls.js 走 MSE 播放（Chrome/Firefox 无原生 HLS），必须一起带上
    if [ -f "$SKILL_DIR/assets/hls.min.js" ]; then
      cp "$SKILL_DIR/assets/hls.min.js" "$dir/hls.min.js"
    fi
  done
fi

# ---------- 校验 ----------
verify_ladder() {  # $1=codec  $2=hls目录  其余=视频档位规格
  local codec="$1" dir="$2"
  shift 2
  local items=("$@") item vname slug
  echo
  echo "=== [$codec] 分段核对 ==="
  for item in "${items[@]}"; do
    IFS=':' read -r vname _ _ _ _ <<<"$item"
    printf "  v_%-6s %s 段\n" "$vname" "$(ls "$dir/$vname"/*.m4s 2>/dev/null | wc -l | tr -d ' ')"
  done
  for item in "${AUDIO_ITEMS[@]}"; do
    IFS=':' read -r vname _ _ _ _ <<<"$item"
    slug="$(printf '%s' "$vname" | tr -c 'A-Za-z0-9_-' '_')"
    printf "  a_%-6s %s 段\n" "$slug" "$(ls "$dir/a_$slug"/*.m4s 2>/dev/null | wc -l | tr -d ' ')"
  done
  if [ "$SUBS_N" -gt 0 ]; then echo "  字幕轨 $SUBS_N 条"; fi

  echo
  echo "=== [$codec] 关键帧对齐（各档前 3 个）==="
  for item in "${items[@]}"; do
    IFS=':' read -r vname _ _ _ _ <<<"$item"
    printf "  v_%-6s " "$vname"
    "$FFPROBE" -v error -select_streams v:0 -skip_frame nokey \
      -show_entries frame=pts_time -of csv=p=0 -read_intervals "%+$((SEG * 3))" \
      "$MEZZ/v_${codec}_$vname.mp4" 2>/dev/null | head -3 | tr '\n' ' '
    echo
  done
}

if [ "$HEVC_N" -gt 0 ]; then verify_ladder hevc "$HLS_HEVC" "${HEVC_ITEMS[@]}"; fi
if [ "$H264_N" -gt 0 ]; then verify_ladder h264 "$HLS_H264" "${H264_ITEMS[@]}"; fi

if [ "$KEEP_MEZZ" = "0" ]; then
  rm -rf "$MEZZ"
  echo
  echo "已删除 mezz 中间文件（--keep-mezz 可保留）"
fi

echo
echo "完成。master 播放列表:"
if [ -n "$HLS_HEVC" ]; then echo "  hevc: $HLS_HEVC/master.m3u8"; fi
if [ -n "$HLS_H264" ]; then echo "  h264: $HLS_H264/master.m3u8"; fi
if [ "$PGS_N" -gt 0 ]; then
  if [ -n "$HLS_HEVC" ]; then echo "  hevc pgs: $HLS_HEVC/pgs-subs/index.json"; fi
  if [ -n "$HLS_H264" ]; then echo "  h264 pgs: $HLS_H264/pgs-subs/index.json"; fi
fi
