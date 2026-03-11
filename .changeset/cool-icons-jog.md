---
'devalue': patch
---

fix: reject `__proto__` keys in malformed `Object` wrapper payloads

This validates the `"Object"` parse path and throws when the wrapped value has an own `__proto__` key.
