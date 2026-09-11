import fs from 'node:fs';

const css = fs.readFileSync('client/src/index.css', 'utf8');

function requireMatch(pattern, message) {
  if (!pattern.test(css)) throw new Error(message);
}

requireMatch(/:where\([^)]*button[^)]*\):focus-visible\{[^}]*outline:[^;}]+;[^}]*outline-offset:[^;}]+;/s,
  'Interactive controls must expose an explicit :focus-visible outline');
requireMatch(/@media\(pointer:coarse\)\{[^}]*button[^}]*min-height:44px/s,
  'Coarse-pointer button targets must be at least 44px high');
requireMatch(/@media\(pointer:coarse\)\{[\s\S]*?\.segmented button\{[^}]*padding:10px 14px/s,
  'Compact segmented controls must receive larger coarse-pointer padding');
requireMatch(/@media\(pointer:coarse\)\{[\s\S]*?\.identity button\{[^}]*min-width:44px/s,
  'Icon-only identity control must preserve a 44px coarse-pointer width');

if (/outline\s*:\s*none/i.test(css)) {
  throw new Error('Global focus outline suppression is forbidden');
}

console.log('FOCUS_TOUCH_ACCESSIBILITY_PASS');
