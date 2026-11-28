/** Transport envelope checks, not JSON Schema semantic validation. The opted-in endpoint must support the dialect. */
export const MAX_RESPONSE_SCHEMA_BYTES = 32_768;
export function isBoundedResponseSchema(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ancestors = new Set<object>(); let nodes = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 16 || ++nodes > 2048) return false;
    if (node === null || typeof node === 'boolean') return true;
    if (typeof node === 'string') return node.length <= MAX_RESPONSE_SCHEMA_BYTES;
    if (typeof node === 'number') return Number.isFinite(node);
    if (typeof node !== 'object' || ancestors.has(node)) return false;
    const array = Array.isArray(node), proto = Object.getPrototypeOf(node);
    if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) return false;
    if (Object.getOwnPropertySymbols(node).length) return false;
    ancestors.add(node);
    const descriptors = Object.getOwnPropertyDescriptors(node);
    for (const [key, property] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      if (!property.enumerable || !('value' in property) || key.length > MAX_RESPONSE_SCHEMA_BYTES) return false;
      if (array && !/^(0|[1-9]\d*)$/.test(key)) return false;
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && (typeof property.value !== 'string' || !property.value.startsWith('#/'))) return false;
      if (!visit(property.value, depth + 1)) return false;
    }
    if (array && Object.keys(descriptors).length !== node.length + 1) return false; // no sparse arrays
    ancestors.delete(node);
    return true;
  };
  try { return visit(value, 0) && Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_RESPONSE_SCHEMA_BYTES; }
  catch { return false; }
}
