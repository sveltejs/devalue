---
'devalue': patch
---

fix: round-trip `undefined`, `NaN`, `Infinity`, `-Infinity` and `-0` when a promise resolves to them in `stringifyAsync`
