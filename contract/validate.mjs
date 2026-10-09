// Minimal JSON-Schema (OpenAPI 3.1 subset) validator: type (incl. unions), enum, properties, required, items,
// additionalProperties (schema form), $ref, oneOf/anyOf. Dependency-free so server and web tests share it.
export function validate(schema, value, spec, at = '$') {
  const errors = [];
  const walk = (s, v, p) => {
    if (!s || s === true) return;
    if (s.$ref) { const name = s.$ref.split('/').pop(); return walk(spec.components.schemas[name] ?? spec.components.responses?.[name]?.content?.['application/json']?.schema, v, p); }
    if (s.oneOf || s.anyOf) { const alts = s.oneOf ?? s.anyOf; if (!alts.some((a) => validate(a, v, spec, p).length === 0)) errors.push(`${p}: matches none of the alternatives`); return; }
    if (s.type) {
      const types = [].concat(s.type); const t = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
      if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) return void errors.push(`${p}: expected ${types.join('|')}, got ${t}`);
    }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (Array.isArray(v) && s.items) v.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of s.required ?? []) if (!(k in v)) errors.push(`${p}: missing required "${k}"`);
      for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) walk(sub, v[k], `${p}.${k}`);
      if (s.additionalProperties && typeof s.additionalProperties === 'object') for (const [k, x] of Object.entries(v)) if (!(s.properties && k in s.properties)) walk(s.additionalProperties, x, `${p}.${k}`);
    }
  };
  walk(schema, value, at); return errors;
}
export const operations = (spec) => Object.entries(spec.paths).flatMap(([path, item]) => Object.entries(item).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(([method, op]) => ({ path, method, ...op })));
