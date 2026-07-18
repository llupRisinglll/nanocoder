import {highlight} from 'cli-highlight';
import {getLanguageFromExtension} from '@/utils/programming-language-helper';

/**
 * Map a file path to a `cli-highlight` language id via its extension.
 * Empty/unknown extensions fall through to `getLanguageFromExtension`'s own
 * default (plain text), which `highlightCode` handles safely either way.
 */
export function languageForPath(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	return getLanguageFromExtension(ext);
}

/**
 * Syntax-highlight a single line/segment of code, returning an ANSI-styled
 * string. Never throws — `cli-highlight` chokes on partial tokens (a lone
 * closing brace, a mid-string segment from word-diff splitting), so any
 * failure falls back to the original plain text, matching the try/catch
 * behavior `string-replace-preview.tsx` already relies on.
 */
export function highlightCode(text: string, language: string): string {
	if (text.length === 0) return text;
	try {
		return highlight(text, {language, theme: 'default'});
	} catch {
		return text;
	}
}
