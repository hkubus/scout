import { normalizeFilterText } from './text';

/**
 * The conditions a manual search understands. `New` and `Used` also narrow
 * the marketplace query; the grades and `Damaged` filter Scout-side only.
 */
export type RequestedCondition = 'Any' | 'New' | 'Used' | 'Damaged' | 'Like new' | 'Very good' | 'Good';

// Folded with normalizeFilterText, so "używany" is "uzywany" and "na części"
// is "na czesci". The grades fold onto CONDITION_ALIASES' keys in service.ts.
const CONDITION_FORMS: ReadonlyArray<readonly [RequestedCondition, readonly string[]]> = [
  ['Any', ['', 'any', 'all', 'dowolny', 'dowolna', 'dowolne', 'wszystkie']],
  ['New', ['new', 'brand new', 'nowy', 'nowa', 'nowe', 'nowka']],
  ['Used', ['used', 'uzywany', 'uzywana', 'uzywane']],
  ['Damaged', ['damaged', 'uszkodzony', 'uszkodzona', 'uszkodzone', 'na czesci', 'for parts', 'broken', 'niesprawny', 'niesprawna', 'niesprawne']],
  ['Like new', ['like new', 'jak nowy', 'jak nowa', 'jak nowe', 'idealny', 'idealna', 'idealne']],
  ['Very good', ['very good', 'bardzo dobry', 'bardzo dobra', 'bardzo dobre']],
  ['Good', ['good', 'dobry', 'dobra', 'dobre']],
];

const CONDITION_BY_FORM = new Map(CONDITION_FORMS.flatMap(([condition, forms]) => forms.map((form) => [form, condition] as const)));

/**
 * A manual search's free-text condition as one Scout knows, in English or
 * Polish. Anything else searches any condition: `recognized` is false so the
 * caller can say so instead of returning an empty page.
 */
export function normalizeRequestedCondition(raw: string | null | undefined): { condition: RequestedCondition; recognized: boolean } {
  const condition = CONDITION_BY_FORM.get(normalizeFilterText(raw ?? ''));
  return condition ? { condition, recognized: true } : { condition: 'Any', recognized: false };
}

/**
 * A listing condition (already folded with normalizeFilterText) that says the
 * item is damaged or sold for parts. Vinted's "Zadowalający" (satisfactory)
 * is a worn but working item, so it is not one. `ł` folds to a space, so
 * "Nie w pełni sprawny" arrives as "nie w pe ni sprawny".
 */
export function isDamagedLabel(normalizedLabel: string) {
  return /(?:^| )(?:uszkodz|na czesci|niesprawn|nie w pe ?l?ni sprawn|damaged|for parts|broken)/.test(normalizedLabel);
}
