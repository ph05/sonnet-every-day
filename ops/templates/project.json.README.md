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
| `tier` | number | `1` full build, `2` compact build, `3` Ideas Day, `4` Postcard. |
| `fingerprint` | object | `category` (a key of `ops/taxonomy.json` `categories`), `mechanic` (one of `mechanics`), `tone` (non-empty subset of `tones`), `tech` (free-form tags such as `canvas2d`), `tags` and `keywords` (3 to 12 lowercase kebab-case strings each), `slot` (`interest`, `currentEvents`, `humor` or `wildcard`), `political` (boolean). |
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
* `date` and `slug` must agree with the directory name, or validation fails.
* The values in `project.json.example` are placeholders (`example.com` is a reserved domain). Replace every one of
  them before publishing.
