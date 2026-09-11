import fs from 'node:fs';

const target = process.argv[2] || 'client/index.html';
const html = fs.readFileSync(target, 'utf8');

const failures = [];

if (!/<html\s+[^>]*lang=["'][a-zA-Z-]+["']/i.test(html)) {
  failures.push('document must declare a non-empty html lang attribute');
}

const viewport = html.match(/<meta\s+[^>]*name=["']viewport["'][^>]*content=["']([^"']+)["'][^>]*>/i)?.[1] ||
  html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']viewport["'][^>]*>/i)?.[1];

if (!viewport) {
  failures.push('viewport meta tag is required');
} else {
  const normalized = viewport.toLowerCase().replace(/\s+/g, '');
  if (!normalized.includes('width=device-width')) failures.push('viewport must use width=device-width');
  if (/maximum-scale\s*=/.test(viewport.toLowerCase())) failures.push('viewport must not cap maximum-scale');
  if (/user-scalable\s*=\s*(no|0)/i.test(viewport)) failures.push('viewport must not disable user scaling');
}

if (!/<meta\s+[^>]*charset=["']?utf-8["']?[^>]*>/i.test(html)) {
  failures.push('UTF-8 charset declaration is required');
}

if (!/<title>\s*[^<]+\s*<\/title>/i.test(html)) {
  failures.push('non-empty document title is required');
}

if (!/<div\s+[^>]*id=["']root["'][^>]*><\/div>/i.test(html)) {
  failures.push('root application mount element is required');
}

if (failures.length) {
  console.error(`Accessibility shell validation failed for ${target}:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Accessibility shell validation passed for ${target}`);
