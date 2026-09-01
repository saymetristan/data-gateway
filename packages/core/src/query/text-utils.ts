const ACCENT_MAP: Record<string, string> = {
  á: 'a',
  à: 'a',
  ä: 'a',
  â: 'a',
  é: 'e',
  è: 'e',
  ë: 'e',
  ê: 'e',
  í: 'i',
  ì: 'i',
  ï: 'i',
  î: 'i',
  ó: 'o',
  ò: 'o',
  ö: 'o',
  ô: 'o',
  ú: 'u',
  ù: 'u',
  ü: 'u',
  û: 'u',
  ñ: 'n',
};

export function normalizeText(value: string): string {
  return unaccent(value).toLowerCase().trim();
}

export function unaccent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[áàäâéèëêíìïîóòöôúùüûñ]/gi, (char) => ACCENT_MAP[char.toLowerCase()] ?? char);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseSpanishNumber(raw: string): number | null {
  let text = raw.replace(/[$€\s]/g, '').trim();
  if (!text) return null;

  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
    text = text.replace(/,/g, '');
  } else {
    text = text.replace(',', '.');
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isShortSkuLikeQuery(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return false;
  if (trimmed.includes(' ')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed);
}

/**
 * Extract an identifier only when the query explicitly labels it, or when the
 * complete query is a short code. This deliberately ignores bare numbers in
 * conversational text so years, prices and measurements keep their meaning.
 */
export function extractExplicitIdentifier(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (
    isShortSkuLikeQuery(trimmed) &&
    /\d/.test(trimmed) &&
    normalizedIdentifierLength(trimmed) >= 3
  ) {
    return trimmed;
  }

  const match = trimmed.match(
    /(?:\b(?:sku|c[oó]digo|code|referencia|ref|parte|part(?:\s+number)?|item)\b|p\s*\/\s*n)\s*(?:#|:|=|-)?\s*([a-z0-9][a-z0-9._/-]{1,31})/iu,
  );
  const identifier = match?.[1]?.replace(/[.,;:]+$/g, '') ?? '';
  return normalizedIdentifierLength(identifier) >= 3 ? identifier : null;
}

export function normalizeIdentifier(value: string): string {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

function normalizedIdentifierLength(value: string): number {
  return normalizeIdentifier(value).length;
}
