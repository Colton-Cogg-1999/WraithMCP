# Wraith Real-World Production Stress-Test Report (v2)

> **Separation of Evidence:** This report evaluates **100% genuine, unmodified open-source production software and real-world public Word documents**. All prior synthetic & mixed-sample benchmark artifacts in `eval/results/pub-audit/` are preserved untouched and are NOT combined with these numbers.

## 1. Corpus & Methodology

- **Software Application:** [`mastodon/mastodon`](https://github.com/mastodon/mastodon) (`a458489b`) — complete React-Intl frontend catalog (`app/javascript/mastodon/locales/en.json`): **1,466 unique English source strings** (`44,794` chars) × **2 target languages** (`es-MX`, `ar`) = **2,932 translated string instances per arm** (**14,660 total translations across 5 arms**).
  - **Production complexity:** `68` ICU plurals, `1` ICU select, `3` multi-plural/nested ICU strings, `229` interpolations, `15` rich-text HTML/custom component tags (`<link>`, `<ul><li>`, `<sr>`, `<topLabel>`), `287` short 1-word ambiguous UI labels, `48` long strings (120+ chars), native `es-MX` and RTL `ar` support.
  - **Wraith usage-site coverage:** `1,462 / 1,466` keys (**99.7%**) mapped to real React component call sites (`<FormattedMessage>`, `defineMessages`, `intl.formatMessage`) across 845 source files after fixing `react-intl` support prior to benchmark freeze.
- **Shared Linguistic Specification (Fairness):** All Codex arms (`B0`, `A0`, `W-pre`, `W-post`) received the exact same project style guide, locale-specific rules (`es-MX` informal `tú` + Mexican UI vocabulary; `ar` Modern Standard Arabic + 6 CLDR plural forms), supplemental translation prompt, and 12-entry approved glossary/DNT list. DeepL (`NMT`) received the same glossary where supported (`es` glossary + `prefer_less` formality; documented limitation: DeepL has no `ES-MX` target code and no `AR` glossary/formality support).
- **Independent Evaluation (Never Wraith-Only):**
  - **Deterministic validation (all 14,660 strings):** Independent `@formatjs/icu-messageformat-parser` (Mastodon's own production ICU parser), placeholder/tag parity, Arabic 6-form CLDR plural completeness, DNT/glossary compliance, and Spain-Spanish regional drift detection.
  - **Blinded linguistic judging:** Claude Opus (`claude -p --model opus`) MQM scoring on a pre-selected stratified 200-key sample per language (`400` unique strings × 5 arms = `2,000` blinded, position-rotated evaluations), **plus 100% of all QE-modified strings** judged blinded & position-swapped (`W-pre` vs `W-post`).
  - **Component-level visual QA (clearly distinguished from full-app E2E):** Playwright rendering 4 dense real Mastodon Storybook components (`NavigationPanel`, `Compose`, `Status`, `Account`) with MSW mock data at Desktop (`1280×800`), Mobile (`375×812`), and Arabic RTL (`dir="rtl"`).

## 2. Mastodon 5-Arm Results (1,466 Keys × 2 Languages = 2,932 Strings/Arm)

### Mexican Spanish (`es-MX`)

| Arm | Keys | Blinded Opus MQM (n=200) | Crit / Maj / Min | ICU Parse Err | Placeholder Mismatch | Rich-Tag Mismatch | Ar Plural Incomplete | DNT Viol | es-ES Drift | Est. API-Eq USD | Tokens (In / Cached / Out) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **NMT (DeepL)** | 1465/1466 | **96.91** | 12 / 42 / 70 | 0 | 0 | 0 | 0 | 0 | 2 | $0.99 | 39,661 chars |
| **B0 (Codex Catalog)** | 1466/1466 | **99.95** | 0 / 0 / 10 | 0 | 0 | 0 | 0 | 0 | 0 | $0.51 | 295k / 217k / 26k |
| **A0 (Codex Repo)** | 1466/1466 | **99.96** | 0 / 0 / 7 | 0 | 0 | 0 | 0 | 0 | 0 | $0.94 | 1102k / 951k / 32k |
| **W-pre (Wraith)** | 1435/1466 | **98.18** | 13 / 2 / 8 | 0 | 0 | 0 | 0 | 0 | 0 | $2.54 | 3947k / 3428k / 39k |
| **W-post (Wraith+QE)** | 1435/1466 | **98.18** | 13 / 2 / 7 | 0 | 0 | 0 | 0 | 0 | 0 | $6.15 (QE: $3.61) | 7525k / 6888k / 29k |

### Arabic (`ar` — RTL)

| Arm | Keys | Blinded Opus MQM (n=200) | Crit / Maj / Min | ICU Parse Err | Placeholder Mismatch | Rich-Tag Mismatch | Ar Plural Incomplete | DNT Viol | es-ES Drift | Est. API-Eq USD | Tokens (In / Cached / Out) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **NMT (DeepL)** | 1465/1466 | **95.84** | 9 / 93 / 92 | 0 | 0 | 0 | 68 | 25 | 0 | $0.96 | 38,557 chars |
| **B0 (Codex Catalog)** | 1466/1466 | **99.81** | 0 / 3 / 21 | 0 | 0 | 0 | 0 | 0 | 0 | $0.55 | 294k / 235k / 34k |
| **A0 (Codex Repo)** | 1466/1466 | **99.78** | 0 / 1 / 36 | 0 | 0 | 0 | 0 | 0 | 0 | $0.90 | 1000k / 888k / 39k |
| **W-pre (Wraith)** | 1435/1466 | **98.15** | 13 / 2 / 13 | 0 | 0 | 0 | 0 | 0 | 0 | $3.33 | 5129k / 4484k / 60k |
| **W-post (Wraith+QE)** | 1435/1466 | **98.06** | 13 / 1 / 34 | 0 | 0 | 0 | 0 | 0 | 0 | $8.33 (QE: $5.00) | 11142k / 10413k / 58k |

## 3. Fresh-Context QE Subagent Audit (100% of QE-Modified Strings Judged Blinded)

Every single string modified by the fresh-context Codex QE subagent (`W-pre` → `W-post`) was evaluated by blinded, position-swapped Claude Opus MQM:

### es-MX
- **QE Context Parity Verified:** StyleGuide=`true`, LocaleRule=`true`, TranslationPrompt=`true`, QePrompt=`true`, Conventions=`true`, DNT=`true`, UsageFileStrings=`1431/1435`
- **QE Edits Applied:** `22` / `1435` strings — **Blinded Opus Judged: `22/22`** (**Improved: `7`**, **Tie/Neutral: `9`**, **Regressed: `6`**, **Net MQM Delta: `-2` pts**)

| Key | Verdict | MQM Δ | Before (`W-pre`) | After (`W-post`) | QE Reason / Blinded Opus Note |
|---|---|---:|---|---|---|
| `account_edit.name_modal.add_title` | **tie** | +0 | Agregar nombre para mostrar | Agregar nombre visible | Both acceptable renderings of 'display name' |
| `account_edit.name_modal.edit_title` | **tie** | +0 | Editar nombre para mostrar | Editar nombre visible | Both acceptable; terminology choice only |
| `account.open_original_page` | **improved** | +1 | Abrir el perfil original | Abrir la página original | A reinterprets 'page' as 'perfil'; B is faithful |
| `status.remove_from_saved` | **regressed** | -1 | Quitar de Guardados | Quitar de Publicaciones guardadas | B mirrors the 'Saved' feature label; A expands it |
| `about.domain_blocks.no_reason_available` | **tie** | +0 | No se indicó el motivo | Motivo no disponible | Both accurate; B more literal, A more natural |
| `account_edit.display_name.placeholder` | **improved** | +1 | Así aparecerá tu nombre en tu perfil y en las cronologías. | El nombre visible es el que aparece en tu perfil y en las cr | B drops the explicit 'display name' concept |
| `account.join_modal.share.celebrate` | **regressed** | -1 | Publicar un mensaje para celebrar | Compartir publicación para celebrar | B lacks article, slightly unnatural |
| `account.join_modal.share.intro` | **regressed** | -1 | Publicar un mensaje de presentación | Compartir publicación de presentación | A lacks article, slightly unnatural |
| `account.join_modal.share.welcome` | **regressed** | -1 | Publicar un mensaje de bienvenida | Compartir publicación de bienvenida | B lacks article, slightly unnatural |
| `navigation_bar.blocked` | **regressed** | -1 | Cuentas bloqueadas | Bloqueos | 'Cuentas bloqueadas' clearer as nav label than 'Bloqueos' |
| `alert.rate_limited.message` | **tie** | +0 | Vuelve a intentarlo después de las {retry_time, time, medium | Vuelve a intentarlo después de esta hora: {retry_time, time, | A 'las' breaks for 1 o'clock; B is safe but awkward |
| `annual_report.summary.percentile.text` | **tie** | +0 | <topLabel>Eso te coloca en el</topLabel><percentage></percen | <topLabel>Eso te coloca en el</topLabel><percentage></percen | Both add 'que más publicaron' not in source; tags preserved |
| `collections.suggestions.can_not_add_desc` | **improved** | +1 | Es posible que estas cuentas hayan elegido no aparecer en la | Es posible que estas cuentas hayan desactivado la opción que | A narrows 'discovery' to recommendations; B accurate though verbose |
| `collections.maximum_collection_count_description` | **tie** | +0 | Tu servidor te permite crear hasta {count} colecciones. | Tu servidor limita a {count} el número de colecciones que pu | Both accurate; B more direct |
| `column.settings` | **regressed** | -5 | Configuración de la columna | (configuración de la columna) | B wraps the title in parentheses it shouldn't have |
| `confirmations.revoke_quote.title` | **tie** | +1 | ¿Quitar tu publicación de la cita? | ¿Quitar la publicación? | A is a faithful literal rendering. B adds 'de la cita', which is not in the sour |
| `email_subscriptions.submitted.lead` | **improved** | +1 | Revisa tu bandeja de entrada. Ahí encontrarás un correo para | Busca en tu bandeja de entrada el correo para completar tu s | A leaves out 'email updates' and splits the sentence into two, which reads less  |
| `quote_error.private_mentions` | **tie** | +0 | No puedes agregar una cita a una mención directa. | No puedes agregar una cita a una mención privada. | Both are accurate. A's 'mención privada' matches Mastodon's current UI term and  |
| `report_notification.categories.legal` | **improved** | +1 | Asunto legal | Motivo legal | Both add a noun to the bare label. 'Motivo legal' fits a report-category list be |
| `report_notification.categories.other` | **tie** | +0 | Otro | Otro motivo | 'Otro' is the exact equivalent. 'Otro motivo' is acceptable and clear as a categ |
| `status.history.created` | **improved** | +1 | {name} la publicó {date} | Publicada por {name} · {date} | In A, 'la publicó {date}' with no preposition or article reads awkwardly once a  |
| `status.history.edited` | **improved** | +1 | {name} la editó {date} | Editada por {name} · {date} | This mirrors the previous item. A's 'Editada por {name} · {date}' is robust, whi |

### ar
- **QE Context Parity Verified:** StyleGuide=`true`, LocaleRule=`true`, TranslationPrompt=`true`, QePrompt=`true`, Conventions=`true`, DNT=`true`, UsageFileStrings=`1431/1435`
- **QE Edits Applied:** `81` / `1435` strings — **Blinded Opus Judged: `81/81`** (**Improved: `18`**, **Tie/Neutral: `30`**, **Regressed: `33`**, **Net MQM Delta: `-13` pts**)

| Key | Verdict | MQM Δ | Before (`W-pre`) | After (`W-post`) | QE Reason / Blinded Opus Note |
|---|---|---:|---|---|---|
| `status.embed` | **tie** | +0 | الحصول على رمز التضمين | الحصول على شيفرة التضمين | Both are correct. رمز (A) can also mean 'symbol', so شيفرة (B) is slightly clear |
| `status.redraft` | **improved** | +5 | حذف المنشور وإعادته إلى المسودات | حذف المنشور وإعادة صياغته | Mastodon has no drafts folder. Re-draft reloads the post into the composer, so B |
| `about.domain_blocks.silenced.explanation` | **improved** | +1 | لن تظهر لك عادةً ملفات مستخدمي هذا الخادم ولا محتواهم، إلا إ | لن ترى عادةً الملفات الشخصية لمستخدمي هذا الخادم أو محتواهم، | A drops الشخصية, so ملفات is ambiguous ('files'). B correctly says 'profiles'. |
| `account_edit_tags.tag_status_count` | **regressed** | -1 | {count, plural, zero {لا توجد منشورات} one {منشور واحد} two  | {count, plural, zero {عدد المنشورات: ⁦#⁩} one {عدد المنشورات | A uses one 'Number of posts: #' label for every plural form, which reads awkward |
| `account_edit.advanced_settings.bot_hint` | **improved** | +5 | أخبر الآخرين بأن هذا الحساب ينفّذ معظم مهامه آليًا، وقد لا ي | أخبر الآخرين بأن هذا الحساب ينفّذ معظم مهامه آليًا، وقد لا ي | In a social app, A's يتابعه reads as 'nobody follows it', not 'not monitored'. B |
| `account_list.total` | **regressed** | -1 | {total, plural, zero {لا حسابات} one {حساب واحد} two {حسابان | {total, plural, zero {عدد الحسابات: ⁦#⁩} one {عدد الحسابات:  | A uses the same label form for every plural category. B gives proper plural agre |
| `account.menu.add_to_feed` | **tie** | +0 | إضافة إلى موجز مخصص… | إضافة إلى خلاصة مخصصة… | موجز and خلاصة are both acceptable terms for 'feed'. |
| `account.menu.direct` | **improved** | +1 | ذكر الحساب على الخاص | إشارة خاصة إلى الحساب | B's على الخاص is colloquial and doesn't suit UI text. A is in Modern Standard Ar |
| `account_edit.field_edit_modal.link_emoji_warning` | **tie** | +0 | نوصي بتجنّب الجمع بين الرموز التعبيرية المخصصة وعناوين الويب | نوصي بتجنّب الجمع بين الرموز التعبيرية المخصصة وعناوين ⁦URL⁩ | Both are accurate. A localizes 'URL' as عناوين الويب, and B keeps 'URL' with bid |
| `account.familiar_followers_many` | **improved** | +6 | يتابع هذا الحساب ⁨{name1}⁩ و⁨{name2}⁩{othersCount, plural, z | من متابعي هذا الحساب: ⁨{name1}⁩ و⁨{name2}⁩{othersCount, plur | Arabic word order (verb–subject–object) makes B's 'يتابع هذا الحساب X' read as ' |
| `account.familiar_followers_one` | **improved** | +5 | يتابع هذا الحساب ⁨{name1}⁩ | من متابعي هذا الحساب: ⁨{name1}⁩ | A's 'يتابع هذا الحساب X' reads as 'this account follows X', the reverse of the s |
| `account.familiar_followers_two` | **improved** | +5 | يتابع هذا الحساب ⁨{name1}⁩ و⁨{name2}⁩ | من متابعي هذا الحساب: ⁨{name1}⁩ و⁨{name2}⁩ | B reverses the follow direction. A is correct. |
| `account.followers_counter` | **improved** | +1 | {count, plural, zero {المتابعون: {counter}} one {المتابعون:  | {count, plural, zero {المتابعون: ⁨{counter}⁩} one {المتابعون | B isolates {counter}, so formatted counts like '1.2K' display safely in right-to |
| `account.followers_you_know_counter` | **improved** | +1 | متابعون تعرفهم: {counter} | متابعون تعرفهم: ⁨{counter}⁩ | A isolates {counter} for right-to-left display. B doesn't. |
| `account.following_counter` | **improved** | +1 | {count, plural, zero {حسابات يتابعها: {counter}} one {حسابات | {count, plural, zero {حسابات يتابعها: ⁨{counter}⁩} one {حساب | B isolates {counter} for right-to-left display. A doesn't. |
| `account.statuses_counter` | **improved** | +1 | {count, plural, zero {المنشورات: {counter}} one {المنشورات:  | {count, plural, zero {المنشورات: ⁨{counter}⁩} one {المنشورات | Same wording in both. A puts bidi isolates around {counter}, which keeps the num |
| `annual_report.summary.percentile.text` | **improved** | +5 | <topLabel>بهذا أصبحت ضمن أعلى</topLabel><percentage></percen | <topLabel>بهذا أصبحت ضمن أعلى</topLabel><percentage></percen | A adds 'in terms of number of posts', which the source doesn't say. B is faithfu |
| `annual_report.announcement.action_build` | **tie** | +0 | إنشاء ملخصي في ⁦Wrapstodon⁩ | إنشاء ملخص ⁦Wrapstodon⁩ الخاص بي | Both are accurate and natural. They differ only in phrasing. |
| `annual_report.announcement.action_view` | **tie** | +0 | عرض ملخصي في ⁦Wrapstodon⁩ | عرض ملخص ⁦Wrapstodon⁩ الخاص بي | Both are accurate and natural. |
| `annual_report.shared_page.footer` | **improved** | +1 | أعدّ فريق ⁦Mastodon⁩ هذا الملخص بكل حب {heart} | أعدّ فريق ⁦Mastodon⁩ هذا الملخص بـ{heart} | In A, {heart} itself stands for 'love', as in the source. B adds 'بكل حب' (with  |
| `status.header.message_from_me` | **regressed** | -2 | منك إلى ⁨{name}⁩{count, plural, =0 {} zero {} one { وشخص آخر | منك إلى ⁨{name}⁩{count, plural, =0 {} zero {} one { (مستلمون | A uses natural Arabic plural forms. B uses one generic '(other recipients: #)' p |
| `status.header.message_to_me` | **regressed** | -2 | من ⁨{author}⁩ إليك{count, plural, =0 {} zero {} one { وإلى ش | من ⁨{author}⁩ إليك{count, plural, =0 {} zero {} one { (مستلم | B uses natural plural forms. A uses the generic 'recipients: #' pattern for ever |
| `status.header.to_followers` | **regressed** | -2 | من ⁨{author}⁩ إلى المتابعين{count, plural, =0 {} zero {} one | من ⁨{author}⁩ إلى المتابعين{count, plural, =0 {} zero {} one | A uses natural plural forms. B uses the generic 'recipients: #' pattern for ever |
| `navigation_bar.blocked` | **regressed** | -1 | الحسابات المحظورة | قائمة الحظر | B, 'blocked accounts', is clearer as a menu label. A, 'block list', is acceptabl |
| `collections.account_count` | **regressed** | -1 | {count, plural, zero {لا حسابات} one {حساب واحد} two {حسابان | {count, plural, zero {عدد الحسابات: ⁦#⁩} one {عدد الحسابات:  | A has idiomatic forms for zero, one and two. B uses 'number of accounts: #', whi |
| `collections.hidden_accounts_link` | **regressed** | -1 | {count, plural, zero {لا حسابات مخفية} one {حساب واحد مخفي}  | {count, plural, zero {عدد الحسابات المخفية: ⁦#⁩} one {عدد ال | B has idiomatic forms for zero, one and two. A uses the awkward 'count: #' patte |
| `column.custom_feeds` | **tie** | +0 | الخلاصات المخصصة | الموجزات المخصصة | Both terms for 'feeds' (خلاصات and موجزات) are acceptable. |
| `custom_feeds.create_a_list_to_organize` | **improved** | +1 | أنشئ خلاصة مخصصة جديدة لتنظيم منشورات الحسابات التي تتابعها. | أنشئ موجزًا مخصصًا جديدًا لتنظيم موجز الحسابات التي تتابعها. | A keeps 'Following feed' as a feed. B paraphrases it as 'posts of accounts you f |
| `custom_feeds.no_custom_feeds_yet` | **tie** | +0 | لا توجد خلاصات مخصصة بعد. | لا توجد موجزات مخصصة بعد. | Both are accurate. They differ only in the word chosen for 'feeds'. |
| `combobox.results_available` | **regressed** | -1 | {count, plural, zero {لا توجد اقتراحات متاحة} one {يتوفر اقت | {count, plural, zero {عدد الاقتراحات المتاحة: ⁦#⁩} one {عدد  | B has natural zero, one and two forms, which suits a screen-reader announcement. |
| *...51 more* | | | | | *(see interactive HTML report for full list)* |

## 4. Mastodon Storybook Component-Level Visual QA (Playwright + MSW)

> **Scope Note:** These captures verify real Mastodon React components rendered via Storybook + MSW mock data (component-level verification, not a full Rails+Postgres+Redis E2E deployment).

| Locale | Arm | Captures | Doc Overflow (>2px) | Clipped Labels | Raw ICU Leaks |
|---|---|---:|---:|---:|---:|
| `es-MX` | **NMT (DeepL)** | 8 | 2 | 0 | 0 |
| `es-MX` | **B0 (Codex Catalog)** | 8 | 2 | 0 | 0 |
| `es-MX` | **W-post (Wraith+QE)** | 8 | 2 | 0 | 0 |
| `ar` | **NMT (DeepL)** | 8 | 1 | 0 | 0 |
| `ar` | **B0 (Codex Catalog)** | 8 | 1 | 0 | 0 |
| `ar` | **W-post (Wraith+QE)** | 8 | 1 | 0 | 0 |

## 5. Real-World Complex `.docx` Benchmark (Publicly Sourced Documents)

| Document | Source Repo / License | Segments | Words | Pages (EN → es-MX) | `doc-verify` | Blinded Opus MQM (n=30) | Est. USD |
|---|---|---:|---:|---:|---|---:|---:|
| **240-DOP-1013A Lay Down Tubulars — Rig Floor Standard Operating Procedure** | `ShayHill/docx2python` | 163 | 1377 | 5 → 6 | **PASS** | **99.87** (0c/0M/4m) | $0.1021 |
| **HIPAA Notice of Privacy Practices** | `apache/poi` | 91 | 3001 | 5 → 6 | **PASS** | **99.73** (0c/0M/8m) | $0.1037 |
| **Journal of Integrated Science & Technology — Manuscript Template** | `apache/poi` | 41 | 1334 | 2 → 2 | **PASS** | **99.9** (0c/0M/3m) | $0.0555 |

### 52-Page Scalability Stress Test (`nci-seer-52p-stress.docx` — US NCI SEER Report)
- **Scale:** 52 pages, `864` Wraith segments, `18370` words, 30 Word fields, 296 hyperlinks, 3.51 runs/paragraph fragmentation.
- **Performance & Integrity:** Extract `118ms` · Byte-identical no-op round-trip `107ms` (`byteIdentical=true`) · Live 50-segment mutated splice `153ms` (`ok=true`) · LibreOffice `doc-verify` `3854ms` (**`PASS`**) · Peak RSS delta `+146 MB`.

*Blinded Claude Opus MQM total judge cost: `$8.434`.*
