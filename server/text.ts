/** Lowercase, strip diacritics, and collapse everything non-alphanumeric to single spaces. */
export function normalizeFilterText(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
