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
