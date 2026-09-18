---
'devalue': patch
---

fix: serialize only the visible bytes of Node Buffers in `stringify`, `stringifyAsync` and `uneval`, preventing disclosure of unrelated data from their shared allocation pool
