---
'devalue': patch
---

fix: preserve shared-reference deduping when a custom `uneval` replacer calls
the callback for nested values

This can cause replacers to run twice for the same value, if the replacer calls
the uneval callback passed to it.
