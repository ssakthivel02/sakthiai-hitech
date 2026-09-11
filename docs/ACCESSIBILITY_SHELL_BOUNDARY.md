# SakthiAI accessibility shell boundary

This control protects the minimum browser shell conditions needed for an accessibility-ready web experience.

## Enforced

- The document declares a non-empty `lang` attribute.
- UTF-8 charset is declared.
- The viewport uses `width=device-width`.
- The viewport must not set `maximum-scale`.
- The viewport must not disable user scaling with `user-scalable=no` or `user-scalable=0`.
- The document has a non-empty title.
- The application root mount remains present.

The negative fixture deliberately contains a zoom-restricting viewport and must fail validation.

## Evidence boundary

Passing this control does **not** prove WCAG conformance, keyboard navigation, screen-reader compatibility, color contrast, focus order, semantic correctness of every route, touch-target sizing, reduced-motion behavior, or responsive rendering across real devices.

Those require route-level and real-browser/device acceptance evidence. This control exists to prevent a known high-impact shell regression from returning while broader accessibility work remains evidence-gated.
