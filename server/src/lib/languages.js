/**
 * 语言显示名 -> BCP-47 语言码
 *
 * 音轨与字幕共用的**唯一事实来源**：扫描推断、默认轨判定、前端徽标都查这里。
 *
 * 匹配规则：显示名 trim 后**转小写**精确匹配（大小写不敏感）。
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
];

const LABEL_TO_LANG = new Map(
  LANGUAGE_LABELS.map((item) => [item.label.toLowerCase(), item.lang])
);

/**
 * 查语言显示名对应的语言码，查不到返回 ''（与脚本行为一致）
 * 音轨名（如 English_5.1 已去掉声道后缀）与字幕名共用此函数
 */
export function langOfName(name) {
  return LABEL_TO_LANG.get(String(name ?? '').trim().toLowerCase()) || '';
}
