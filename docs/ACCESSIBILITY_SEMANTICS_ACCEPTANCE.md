# Accessibility semantics acceptance

This lane closes two concrete repository-level accessibility defects in the authenticated workspace UI without claiming broad WCAG conformance.

## Enforced behavior

- The EN / தமிழ் language selector is exposed as a named control group.
- Each language button exposes its current selected state through `aria-pressed`.
- Language controls are explicit `type="button"` controls.
- Dynamic chat answers are exposed through a polite live region so assistive technology can announce returned content without interrupting the user.
- Existing named workspace navigation and icon-only logout labeling remain guarded.

## Evidence boundary

A green repository check proves only these source-level semantics. It does not prove screen-reader behavior across NVDA, JAWS, VoiceOver, or TalkBack; keyboard focus order; contrast; touch-target sizing; reduced-motion behavior; mobile responsiveness; or WCAG 2.2 conformance.

Those require browser/device and assistive-technology acceptance against the exact deployed commit.
