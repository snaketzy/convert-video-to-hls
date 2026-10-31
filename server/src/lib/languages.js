/**
 * 语言显示名 -> BCP-47 语言码
 *
 * 音轨与字幕共用的**唯一事实来源**：扫描推断、默认轨判定、前端徽标都查这里。
 *
 * 匹配规则：显示名 trim 后**转小写**精确匹配（大小写不敏感）；
 * 显示名查不到时，若该串本身就是形似 BCP-47 的语言码（如 en、ja、zh-Hans、fr-CA、es-419），
 * 则**原样**作为语言码使用（und 仍视为未知）。
 * 必须与 encode_hls.sh 里的 lang_of() 保持一致：
 * 脚本按同一张表把语言码写进 master.m3u8，查不到就不带 lang=。
 * 语言未知（und / 空）不参与匹配，packager 会直接拒绝 lang=und。
 */
export const LANGUAGE_LABELS = [
  { label: 'Arabic', lang: 'ar' },
  { label: 'Bulgarian', lang: 'bg' },
  { label: 'Cantonese', lang: 'yue' },
  { label: 'Chinese', lang: 'zh' },
  { label: 'Chinese (Cantonese)', lang: 'yue' },
  { label: 'Chinese (Simplified)', lang: 'zh-Hans' },
  { label: 'Chinese (Traditional)', lang: 'zh-Hant' },
  { label: 'Croatian', lang: 'hr' },
  { label: 'Czech', lang: 'cs' },
  { label: 'Danish', lang: 'da' },
  { label: 'Dutch', lang: 'nl' },
  { label: 'English', lang: 'en' },
  { label: 'Estonian', lang: 'et' },
  { label: 'Finnish', lang: 'fi' },
  { label: 'French', lang: 'fr' },
  { label: 'French (Canada)', lang: 'fr-CA' },
  { label: 'French (Canada)-2', lang: 'fr-CA' },
  { label: 'French (France)', lang: 'fr-FR' },
  { label: 'French (Parisian)', lang: 'fr-FR' },
  { label: 'German', lang: 'de' },
  { label: 'Greek', lang: 'el' },
  { label: 'Hebrew', lang: 'he' },
  { label: 'Hungarian', lang: 'hu' },
  { label: 'Icelandic', lang: 'is' },
  { label: 'Italian', lang: 'it' },
  { label: 'Japanese', lang: 'ja' },
  { label: 'Korean', lang: 'ko' },
  { label: 'Latvian', lang: 'lv' },
  { label: 'Lithuanian', lang: 'lt' },
  { label: 'Mandarin', lang: 'zh' },
  { label: 'Norwegian', lang: 'nb' },
  { label: 'Polish', lang: 'pl' },
  { label: 'Portuguese', lang: 'pt' },
  { label: 'Portuguese (Brazil)', lang: 'pt-BR' },
  { label: 'Portuguese (Iberian)', lang: 'pt-PT' },
  { label: 'Romanian', lang: 'ro' },
  { label: 'Russian', lang: 'ru' },
  { label: 'Slovak', lang: 'sk' },
  { label: 'Slovenian', lang: 'sl' },
  { label: 'Spanish', lang: 'es' },
  { label: 'Spanish (Castilian)', lang: 'es-ES' },
  { label: 'Spanish (Latin America)', lang: 'es-419' },
  { label: 'Spanish (Spain)', lang: 'es-ES' },
  { label: 'Swedish', lang: 'sv' },
  { label: 'Thai', lang: 'th' },
  { label: 'Traditional Chinese', lang: 'zh-Hant' },
  { label: 'Traditional Chinese(HK)', lang: 'zh-Hant-HK' },
  { label: 'Turkish', lang: 'tr' },
  { label: 'Ukrainian', lang: 'uk' },
  { label: 'Vietnamese', lang: 'vi' },
  // 语言码别名：可直接用编码侧的语言码作为轨道名
  { label: 'zh-CN', lang: 'zh-Hans' },
  { label: 'zh-TW', lang: 'zh-Hant' },
  { label: 'zh-HK', lang: 'zh-Hant-HK' },
  { label: 'zh-Hans', lang: 'zh-Hans' },
  { label: 'zh-Hant', lang: 'zh-Hant' },
  { label: 'zh-Hant-HK', lang: 'zh-Hant-HK' },
  { label: 'zh_cn', lang: 'zh-Hans' },
  { label: 'zh_tw', lang: 'zh-Hant' },
  { label: 'zh_hk', lang: 'zh-Hant-HK' },
];

const LABEL_TO_LANG = new Map(
  LANGUAGE_LABELS.map((item) => [item.label.toLowerCase(), item.lang])
);

/** 形似 BCP-47 语言码：2~3 位主语言 + 若干位子标签（如 en、yue、zh-Hans、fr-CA、es-419） */
const BCP47_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * 查语言显示名对应的语言码，查不到返回 ''（与脚本行为一致）
 * 音轨名（如 English_5.1 已去掉声道后缀）与字幕名共用此函数
 *
 * 显示名查不到时做一次回退：若该串本身就是形似 BCP-47 的语言码则原样返回，
 * 这样轨道名直接写成 en / zh-Hans 也能正确带 lang=；und 视为未知，不回退。
 */
export function langOfName(name) {
  const text = String(name ?? '').trim();
  if (!text) return '';
  const mapped = LABEL_TO_LANG.get(text.toLowerCase());
  if (mapped) return mapped;
  if (text.toLowerCase() !== 'und' && BCP47_PATTERN.test(text)) return text;
  return '';
}

/**
 * PGS 位图字幕的标签 -> 语言码 + 显示名
 *
 * .sup 文件常以 chs / cht / eng / chs&eng 这类简写命名，两边都不在 LANGUAGE_LABELS 里。
 * 位图字幕不参与 master.m3u8 的 lang= 匹配，只用于生成 pgs-subs/index.json 的 lang / name。
 * 查不到时：lang 回退 langOfName()，name 用标签原文。
 */
export const PGS_LABELS = [
  { label: 'chs', lang: 'zh-Hans', name: '简体中文' },
  { label: 'cht', lang: 'zh-Hant', name: '繁体中文' },
  { label: 'chi', lang: 'zh', name: '中文' },
  { label: 'zho', lang: 'zh', name: '中文' },
  { label: 'eng', lang: 'en', name: 'English' },
  { label: 'chs&eng', lang: 'zh-Hans', name: '简体中文+英文' },
  { label: 'cht&eng', lang: 'zh-Hant', name: '繁体中文+英文' },
  { label: '简体中文', lang: 'zh-Hans', name: '简体中文' },
  { label: '繁体中文', lang: 'zh-Hant', name: '繁体中文' },
  { label: '中文', lang: 'zh', name: '中文' },
  { label: '英文', lang: 'en', name: 'English' },
  { label: '英语', lang: 'en', name: 'English' },
];

const PGS_LABEL_MAP = new Map(PGS_LABELS.map((item) => [item.label.toLowerCase(), item]));

/** 查 PGS 标签对应的 { lang, name }；查不到时 lang 回退 langOfName，name 用标签原文 */
export function pgsMetaOf(rawLabel) {
  const text = String(rawLabel ?? '').trim();
  const hit = PGS_LABEL_MAP.get(text.toLowerCase());
  if (hit) return { lang: hit.lang, name: hit.name };
  return { lang: langOfName(text), name: text };
}
