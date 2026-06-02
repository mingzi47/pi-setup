/**
 * Language detection utility for caveman extension.
 * Returns "zh" if text contains any CJK character, otherwise "en".
 */
export function detectLanguage(text: string): "zh" | "en" {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
    return "zh";
  }
  return "en";
}
