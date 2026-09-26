import fs from 'node:fs';

const source = fs.readFileSync('client/src/pages/Home.tsx', 'utf8');
const fail = message => { console.error(message); process.exit(1); };
const requireText = (text, message) => { if (!source.includes(text)) fail(message); };
const requirePattern = (pattern, message) => { if (!pattern.test(source)) fail(message); };

requireText('role="group" aria-label="Chat language"', 'Chat language selector must expose a named group');
requireText('aria-pressed={language === "en"}', 'English language control must expose selected state');
requireText('aria-pressed={language === "ta"}', 'Tamil language control must expose selected state');
requirePattern(
  /<button\b(?=[^>]*\btype="button")(?=[^>]*\baria-pressed=\{language === "en"\})[^>]*>/,
  'English language control must be an explicit non-submit button',
);
requirePattern(
  /<button\b(?=[^>]*\btype="button")(?=[^>]*\baria-pressed=\{language === "ta"\})[^>]*>/,
  'Tamil language control must be an explicit non-submit button',
);
requireText('className="answer-area" aria-live="polite" aria-atomic="false"', 'Dynamic answer region must announce updates politely');
requireText('aria-label="Workspace navigation"', 'Workspace navigation must remain named');
requireText('aria-label="Log out"', 'Icon-only logout control must remain named');

console.log('Accessibility semantics PASS');
