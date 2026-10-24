/** 划词翻译: selected text in the 文献库 reader, translated by the sync server (DeepL or an OpenAI-compatible API). */

export type TranslateEngine = 'deepl' | 'openai';

/** Languages to translate into: our code, the name the prompt uses, DeepL's target code. */
export const TRANSLATE_TARGETS = [
  { id: 'zh-CN', label: '简体中文', deepl: 'ZH-HANS', prompt: 'Simplified Chinese' },
  { id: 'zh-TW', label: '繁體中文', deepl: 'ZH-HANT', prompt: 'Traditional Chinese' },
  { id: 'en', label: 'English', deepl: 'EN-US', prompt: 'English' },
  { id: 'ja', label: '日本語', deepl: 'JA', prompt: 'Japanese' },
  { id: 'ko', label: '한국어', deepl: 'KO', prompt: 'Korean' },
  { id: 'de', label: 'Deutsch', deepl: 'DE', prompt: 'German' },
  { id: 'fr', label: 'Français', deepl: 'FR', prompt: 'French' },
  { id: 'es', label: 'Español', deepl: 'ES', prompt: 'Spanish' },
] as const;

/** The settings as clients see them: keys never leave the server, only their last characters. */
export interface TranslateSettingsView {
  /** null: translation is off. */
  engine: TranslateEngine | null;
  target: string;
  /** Engines that have what they need, with the name to show (the model, for OpenAI). */
  engines: { id: TranslateEngine; label: string }[];
  deepl: { key: string | null };
  openai: { baseUrl: string; model: string; key: string | null };
}

/** A change: key fields left out stay as they are, '' clears them. */
export interface TranslateSettingsInput {
  engine?: TranslateEngine | null;
  target?: string;
  deeplKey?: string;
  openaiBaseUrl?: string;
  openaiModel?: string;
  openaiKey?: string;
}

export interface TranslateResult {
  /** Translation is turned off: show nothing. */
  off?: boolean;
  text?: string;
  engine?: TranslateEngine;
  label?: string;
  cached?: boolean;
  engines: { id: TranslateEngine; label: string }[];
}
