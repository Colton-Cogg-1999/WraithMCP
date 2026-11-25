# Polyglot `.polyglot/` File Schemas

All Polyglot state lives inside `.polyglot/` in the repository root. Every file is plain UTF-8 text, human-readable, deterministically sorted for clean git diffs, and validated at runtime with Zod.

---

## 1. `.polyglot/config.json`

Minimal project configuration. All fields except `sourceLocale` and `targetLocales` have sensible defaults.

```json
{
  "version": 1,
  "sourceLocale": "en",
  "targetLocales": ["es-MX", "fr", "zh-Hans"],
  "review": "auto",
  "framework": "auto",
  "paths": {
    "locales": "messages",
    "source": ["src", "app", "components"],
    "documents": [],
    "ignore": ["node_modules", ".next", "dist", "build", ".git", ".polyglot"]
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `version` | `1` | `1` | Schema version. |
| `sourceLocale` | `string` | `"en"` | BCP-47 source locale tag. |
| `targetLocales` | `string[]` | `[]` | BCP-47 target locale tags. |
| `review` | `"auto" \| "confirm"` | `"auto"` | `"auto"`: infer glossary & proceed, surface assumptions in report. `"confirm"`: ask developer to confirm key terms first. |
| `framework` | `"auto" \| "react" \| "nextjs" \| "vue" \| "nuxt" \| "sveltekit" \| "rails" \| "django" \| "documents"` | `"auto"` | Detected automatically unless overridden. |
| `i18nLibrary` | `string?` | auto | Optional override (`"next-intl"`, `"react-i18next"`, `"vue-i18n"`, `"paraglide"`, `"svelte-i18n"`, `"rails-i18n"`, `"django-gettext"`). |
| `paths.locales` | `string?` | auto | Directory or glob pattern for locale files. |
| `paths.source` | `string[]` | `["."]` | Directories to scan for hardcoded strings and key usage. |
| `paths.documents` | `string[]` | `[]` | Markdown/MDX/DOCX files or directories to localize. |
| `paths.ignore` | `string[]` | standard ignores | Paths excluded from scanning. |

---

## 2. `.polyglot/glossary.json`

Preferred terminology and do-not-translate (DNT) terms. Sorted alphabetically by `term`.

```json
{
  "version": 1,
  "entries": [
    {
      "term": "Acme Pulse",
      "doNotTranslate": true,
      "caseSensitive": true,
      "translations": {},
      "notes": "Product brand name",
      "origin": "inferred",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    },
    {
      "term": "Post",
      "doNotTranslate": false,
      "caseSensitive": false,
      "translations": {
        "es-MX": "publicación",
        "fr": "publication",
        "zh-Hans": "帖子"
      },
      "notes": "Noun: a blog/feed entry, not the verb to publish",
      "origin": "user",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `term` | `string` | Source-language term. |
| `doNotTranslate` | `boolean` | If `true`, term must appear verbatim in target strings. |
| `caseSensitive` | `boolean` | Whether matching respects casing (default `false`, `true` for brand names). |
| `translations` | `Record<locale, string>` | Preferred target translation per locale (empty when `doNotTranslate: true`). |
| `notes` | `string?` | Disambiguation context for agents and reviewers. |
| `origin` | `"inferred" \| "user" \| "imported"` | Provenance of the glossary decision. |
| `updatedAt` | `string` (ISO-8601) | Last modification timestamp. |

---

## 3. `.polyglot/usage.json`

Extracted key usage sites and context fingerprints. Regenerated deterministically on `scan` and `check`. Keys sorted alphabetically.

```json
{
  "version": 1,
  "keys": {
    "nav.open": {
      "fingerprint": "a84f2c9e1d0b...",
      "sites": [
        {
          "file": "src/components/Header.tsx",
          "line": 24,
          "component": "Header",
          "element": "button",
          "surrounding": ["File", "Save", "Close"]
        }
      ]
    }
  }
}
```

**Context fingerprint calculation:** SHA-256 hex digest (first 16 chars) of the canonical JSON array of sorted `(file, component, element, sorted surrounding strings)` tuples. Line numbers are intentionally excluded so unrelated edits above a component do not trigger false context-change alerts.

---

## 4. `.polyglot/records.json`

Per-key, per-locale translation provenance and verification state. Sorted by key, then by locale.

```json
{
  "version": 1,
  "records": {
    "home.hero.title": {
      "es-MX": {
        "sourceHash": "9f86d081884c7d65",
        "contextFingerprint": "a84f2c9e1d0b3120",
        "translation": "Bienvenido a Acme Pulse",
        "updatedAt": "2026-01-01T00:00:00.000Z",
        "origin": "agent",
        "reviewStatus": "unreviewed",
        "notes": ""
      }
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `sourceHash` | `string` | First 16 hex chars of SHA-256 of the source string at translation time. |
| `contextFingerprint` | `string` | Context fingerprint from `usage.json` at translation time (empty string if no usage site). |
| `translation` | `string` | Stored target string (or canonical JSON for plural maps). |
| `updatedAt` | `string` (ISO-8601) | When last applied or imported. |
| `origin` | `"agent" \| "imported" \| "human" \| "pseudo"` | How the translation was produced. |
| `reviewStatus` | `"unreviewed" \| "reviewed" \| "approved" \| "flagged"` | Quality cascade status. |
| `notes` | `string?` | Optional translator or reviewer note. |

---

## 5. `.polyglot/memory.jsonl`

Append-friendly, deduplicated newline-delimited JSON translation memory for lexical fuzzy matching. Each line is one source→target unit:

```json
{"sourceLocale":"en","targetLocale":"es-MX","source":"Save changes","target":"Guardar cambios","context":"Button in SettingsForm","origin":"apply","updatedAt":"2026-01-01T00:00:00.000Z"}
```

When written by `apply`, `import`, or `escalate` (correction import), entries with matching `(sourceLocale, targetLocale, source, target)` are updated in place to avoid unbounded duplicate growth while keeping diffs line-oriented.

---

## 6. `.polyglot/assumptions.json`

Decisions the agent made without interrupting the developer (surfaced in the end-of-run report).

```json
{
  "version": 1,
  "assumptions": [
    {
      "id": "a1b2c3d4",
      "category": "tone",
      "locale": "es-MX",
      "summary": "Used informal 'tú' register for es-MX consumer UI.",
      "rationale": "App copy is casual and developer-facing.",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Categories: `"terminology" | "brand" | "tone" | "disambiguation" | "formatting" | "scope" | "other"`.

---

## 7. `.polyglot/reviews.json`

Cross-model MQM review findings and human escalation resolutions.

```json
{
  "version": 1,
  "reviews": [
    {
      "id": "rev-001",
      "key": "feed.postLabel",
      "locale": "es-MX",
      "reviewer": "gemini-cli",
      "category": "terminology",
      "severity": "major",
      "span": "entrada",
      "explanation": "Glossary prefers 'publicación' for noun 'Post'.",
      "suggestion": "publicación",
      "verified": true,
      "status": "open",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

- `category`: `"accuracy" | "fluency" | "terminology" | "style" | "locale-conventions" | "placeholders" | "other"`
- `severity`: `"critical" | "major" | "minor" | "neutral"`
- `status`: `"open" | "resolved" | "dismissed" | "escalated"`
