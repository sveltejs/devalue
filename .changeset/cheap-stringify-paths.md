---
'devalue': patch
---

perf: `stringify` and `uneval` skip per-character escaping for strings with nothing to escape, and record the error path without formatting it (or allocating per Map entry) until a `DevalueError` is raised
