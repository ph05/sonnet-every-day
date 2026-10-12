# project.json

Every project directory `docs/d/<date>-<slug>/` carries a `project.json` next to its `index.html` and `thumb.png`.
`project.json.example` is a complete, valid file; copy it and edit the values. The authoritative shape is
CONTRACT section 5.6; `scripts/validate.mjs project <dir>` enforces it.

| Field | Type | Rules |
|---|---|---|
| `schema` | number | Always `1`. |
| `date` | string | Local calendar date `YYYY-MM-DD` (America/New_York). The directory is named `<date>-<slug>`. |
| `slug` | string | Lowercase kebab-case (`a-z`, `0-9`, single hyphens). Unique across history. |
| `title` | string | 2 to 4 words. Must match the page's `<title>` and `<h1>`. |
| `tagline` | string | At most 120 characters. Shown on the gallery card. |
| `description` | string | 1 to 3 sentences (a warning past 800 characters). |
| `intro` | string | Plain text, 35 to 70 words (`config.json` `pageContract.intro`): what this is, who it is for, what to do first. Its first sentence says what the thing literally is (at most 30 words, else a warning). It must equal the text of the page's `p.sed-intro[data-sed-intro]` exactly, entities decoded and whitespace collapsed. Required for tiers 1 and 2 from `pageContract.requiredFrom` on (or with `validate.mjs project --contract`); checked whenever present. |
| `concepts` | string[] | Optional: 1 to 6 terms of 2 to 40 characters that the page teaches or defines (the gallery searches them). |
| `tier` | number | `1` full build, `2` compact build, `3` Ideas Day, `4` Postcard. |
| `fingerprint` | object | `purpose` (a key of `ops/taxonomy.json` `purposes`: `tool`, `lesson`, `explorer`, `studio` or `play`; required for tiers 1 and 2 from `pageContract.requiredFrom` on, valid whenever present), `category` (a key of `ops/taxonomy.json` `categories`), `mechanic` (one of `mechanics`), `tone` (non-empty subset of `tones`), `tech` (free-form tags such as `canvas2d`), `tags` and `keywords` (3 to 12 lowercase kebab-case strings each), `slot` (`interest`, `currentEvents`, `humor` or `wildcard`), `political` (boolean). |
| `palette` | string[] | 2 to 8 hex colors (`#rgb` or `#rrggbb`). The gallery tints the card from these, so put the page's real colors first. |
| `entry` | string | Relative path of the page, normally `index.html`. |
| `thumb` | string | Relative path of the thumbnail, normally `thumb.png`: exactly 1200x630 PNG, at most `limits.thumbMaxBytes` (300 KB). Generate it with `node scripts/qa/browser-check.mjs <dir> --out <qa dir> --thumb`. |
| `network` | string[] | Bare hostnames (no scheme, port or path) the page fetches at runtime. Default `[]` means fully offline. Every listed host must also be in the page's CSP `connect-src`. Live data is a graceful enhancement only; the page must still work offline. |
| `sources` | `{title, url}[]` | The pages actually consulted (http or https URLs). Never list a page that was not really read. Tier 1 and 2 need at least one. |
| `makingOf` | string | A short paragraph, same content as the page's "About & making of" panel. |
| `stats` | object | `{files, bytes, ownLoc}`: file count, total bytes and lines of the project's own code. The packaging step recomputes it; any numbers are fine in the example. |
| `credits` | string | Normally `Built by the Sonnet Every Day team`. |

Notes

* JSON has no comments; keep this README as the field reference.
* The page itself carries the intro paragraph and the explainer section as static markup (see the header comment of
  `page-shell.html`). From `pageContract.requiredFrom` on, `validate.mjs project` checks them on tiers 1 and 2: the intro
  (`intro-*` codes), the explainer's words and headings per purpose (`explainer-*`), and for a lesson at least
  `lessonMinChecks` elements with `data-sed-check`. `browser-check.mjs` checks that both are rendered, that the intro ends
  within the first screen, the first-screen control budget, and runs `window.__sedSelfTest` (required for a tool).
* `date` and `slug` must agree with the directory name, or validation fails.
* The values in `project.json.example` are placeholders (`example.com` is a reserved domain). Replace every one of
  them before publishing.
