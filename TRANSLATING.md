# Translating ClipWorld

Every piece of text in ClipWorld lives in one file per language in [`src/locales/`](src/locales):

- `en.json` is English, the source. Every other language is translated from it.
- `ja.json` is Japanese.

Anything a language doesn't have yet is shown in English, so a translation can be added a bit at a time. The **Language** dialog (**Edit ▸ Language…**) shows how complete each language is.

## Adding or improving a language

1. Copy `src/locales/en.json` to `src/locales/<code>.json`, where `<code>` is the language's code: `de` for German, `fr` for French, `pt-BR` for Brazilian Portuguese, `zh-Hans` for Simplified Chinese, and so on. A new file shows up in the Language dialog by itself.
2. Translate the text on the right of each `:`. Leave the keys on the left as they are.
3. Delete anything you haven't translated yet. It will show in English until someone does.
4. Run `npm test`. It checks every translation file and says exactly what to fix.

### Rules

- **Keep `{{placeholders}}` exactly as they are.** ClipWorld fills them in: `"Removed {{name}}"` might show as "Removed holiday.mp4". You can move them anywhere in the sentence.
- **Plurals.** Keys ending in `_one` and `_other` are the singular and plural forms of one message: `"{{count}} audio track"` and `"{{count}} audio tracks"`. Use the forms your language has: `_zero`, `_one`, `_two`, `_few`, `_many`, `_other`. Languages without plurals, such as Japanese, only need `_other`. The tests reject a form your language doesn't use.
- **Leave names as they are:** ClipWorld, ffmpeg, file formats and codecs (MP4, H.264, NVIDIA NVENC), and key names (Ctrl, Shift, Space).
- Messages ending in `…` open a dialog or ask for more input. Keep the `…`.
- Short text that runs too long gets cut off with "…" (the full text appears on hover), so prefer short wording for buttons and labels.

## Checking your translation in the app

```bash
npm run dev
```

Choose your language in **Edit ▸ Language…**. It switches immediately, without restarting.

**Pseudo-language (for testing)** in the same dialog shows every message as accented English in brackets, about 40% longer, like `[Šþļîţ åţ þļåýĥéåđ ~~~~]`. Plain English left on screen is text that can't be translated yet (please report it). Text that gets cut off shows where longer languages won't fit.

`npm run test:e2e` includes a test that opens every window, menu and dialog in the pseudo-language and in each language, and fails on any English left over.

## Translating on Weblate or Crowdin

Both sites let people translate in the browser and send the results back as pull requests. Both are free for open-source projects. To connect one:

- **File format:** i18next JSON v4 (Weblate calls it "i18next JSON file v4". Crowdin uses "JSON (i18next)").
- **Source file:** `src/locales/en.json`
- **Translation files:** `src/locales/<code>.json`, using codes with a hyphen (`pt-BR`, not `pt_BR`)

## For developers

- In components, `const t = useT()` (from `src/renderer/i18n.ts`) gives `t('key', { placeholder })` and re-renders when the language changes. Code outside components imports `t` from `@shared/i18n`; the main process uses the same function for native dialogs and error messages.
- Effects, easing curves, export formats and subtitle formats are named by id: `effects.<type>.name`, `effects.<type>.params.<key>`, `formats.containers.<id>`, and so on (see `src/shared/labels.ts`). Adding one means adding its English name to `en.json`; the tests list any that are missing.
- Keep user data (file names, subtitle text, track names) out of messages and pass it in as a placeholder.
