# Translation files

Use the **Template** button in Assembly Studio to download a translation file.
Only three fields matter:

- `locale`: a language code such as `de` or `pt-br`;
- `name`: the language name shown in the selector;
- `messages`: translated text keyed by stable identifiers.

Keep placeholders such as `{revision}`, `{count}` and `{label}` unchanged. Empty
messages automatically fall back to English, so a translation can be imported
and tested while it is still incomplete. The browser validates the file before
storing it locally. No rebuild, server access or JavaScript knowledge is needed.

Built-in packs are `en.json`, `it.json`, `fr.json` and `es.json`. The formal
format is documented by `translation.schema.json`.
