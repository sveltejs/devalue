---
'devalue': minor
---

feat: add pluggable `operations` option to `stringify`/`stringifyAsync`. Every introspection performed on the value being serialized (property reads, prototype method calls, iteration, type classification) now routes through an overridable `StringifyOperations` interface, enabling side-effect-free serialization (no getters, proxy traps, or patched prototype methods) and serialization of values in foreign runtimes via handles. Defaults are exported as `defaultOperations` and preserve existing behavior exactly.
