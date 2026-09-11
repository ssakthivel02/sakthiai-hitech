# Focus and touch accessibility acceptance boundary

This lane advances the Issue #1 responsive/mobile/accessibility P0 item without claiming complete WCAG conformance.

## Repository evidence

The canonical stylesheet must provide:

- an explicit `:focus-visible` treatment for keyboard-focusable interactive controls;
- a visible outline with offset rather than suppressing browser focus indication;
- coarse-pointer minimum target height of 44px for buttons, sidebar navigation links, segmented language controls and file inputs;
- larger coarse-pointer padding for the compact segmented language selector;
- a 44px minimum coarse-pointer width for the icon-only identity control.

The dedicated CI validator fails if these source-level controls regress.

## What this does not prove

Repository validation does not prove:

- full WCAG 2.2 AA conformance;
- actual keyboard tab-order quality;
- visible focus appearance on every component/theme/background;
- browser zoom/reflow PASS at 200% or 400%;
- screen-reader PASS;
- contrast PASS;
- physical touch accuracy on representative phones/tablets;
- real-device responsive PASS.

Those require controlled browser/device acceptance against the exact deployed commit.
