---
paths:
  - 'src/modules/**/MODULE.md'
---

# MODULE.md

- Under V2, use `public/<area>/<operation>` entries and document the named provider exported by
  Nest. The `execute` signature uses only public types, including nested types. Keep documentation
  accurate for modules still using the existing layout.

- Use the nine sections in [cw-module-md](../skills/cw-module-md/SKILL.md).
- In Public entry points, declare owner-relative paths without `.ts` in an `Entry point | Consumers`
  table, with exact consumer module names. Write `None` when the module has no consumers.
- Update it in the same change that adds or moves a route, an event, a table or an invariant.
- Normative and short: no file catalog, no restated code.
