---
'devalue': patch
---

fix: disallow `__proto__` keys in null-prototype object parsing

This disallows `__proto__` keys in the `"null"` parse path so null-prototype object hydration cannot carry that key through parse/unflatten.
