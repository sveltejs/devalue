---
'devalue': patch
---

fix: reject non-string null-prototype object keys in `parse` and `unflatten` to prevent bypassing the `__proto__` check
