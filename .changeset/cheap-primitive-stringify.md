---
'devalue': patch
---

perf: only call `stringify` reducers for objects, functions and symbols, and only deduplicate small non-negative integers
