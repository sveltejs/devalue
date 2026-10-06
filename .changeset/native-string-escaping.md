---
'devalue': patch
---

fix: use native `JSON.stringify` for strings that need escaping, instead of a per-character loop
