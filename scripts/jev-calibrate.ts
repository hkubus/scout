/**
 * Local Jev vs DeepSeek calibration (Phase 1).
 *
 * Runs curated Polish sample cases through both DeepSeek (chat-completions)
 * and Jev (Decisions), plus the vision fallback wherever Jev is unsure, then
 * prints per-case results with an agreement summary. Use the output to tune
 * RELEVANCE_UNSURE_* / VERIFICATION_MIN_CONFIDENCE in server/jev.ts.
 *
 * Requires an OpenRouter key: SCOUT_OPENROUTER_API_KEY (or OPENROUTER_API_KEY),
 * or SCOUT_SECRET (+ SCOUT_DB_PATH if non-default) so the encrypted key saved
 * in settings can be decrypted like the app does. Runs live calls
 * sequentially to stay far under rate limits; ~30 small calls total.
 *
 * Usage:
 *   SCOUT_OPENROUTER_API_KEY=sk-or-... npx tsx scripts/jev-calibrate.ts
 *   SCOUT_JEV_MODEL=typesafe/jev-1.13 SCOUT_OPENROUTER_API_KEY=sk-or-... npx tsx scripts/jev-calibrate.ts
 */

import { resolve } from 'node:path';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { classifyListingRelevanceWithDeepSeek, verifyListingDescriptionWithDeepSeek } from '../server/ai';
import { classifyListingRelevanceWithJev, verifyListingDescriptionWithJev } from '../server/jev';
import { classifyListingRelevanceWithVision, verifyListingDescriptionWithVision } from '../server/vision';
import { decryptSecret } from '../server/service';

export {};

/**
 * Resolve the OpenRouter key exactly like the app does: explicit env first,
 * then the encrypted `openrouter_api_key` setting from the local database
 * (needs SCOUT_SECRET — the same secret the app runs with). The key only ever
 * lives in memory here; this script never prints it.
 */
function resolveApiKey(): string | null {
  const env = process.env.SCOUT_OPENROUTER_API_KEY?.trim()
    || process.env.OPENROUTER_API_KEY?.trim()
    || null;
  if (env) return env;
  const secret = process.env.SCOUT_SECRET;
  if (!secret) return null;
  try {
    const db = new DatabaseSync(resolve(process.env.SCOUT_DB_PATH ?? './data/scout.sqlite'), { readOnly: true });
    try {
      for (const name of ['openrouter_api_key', 'deepseek_api_key']) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(name) as { value?: unknown } | undefined;
        if (typeof row?.value !== 'string' || !row.value) continue;
        try {
          const decrypted = decryptSecret(row.value).trim();
          if (decrypted) return decrypted;
        } catch {
          // Wrong SCOUT_SECRET for this database — try the next stored key.
        }
      }
    } finally {
      db.close();
    }
  } catch {
    // No readable database — fall through to the missing-key error below.
  }
  return null;
}

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error('Missing API key. Set SCOUT_OPENROUTER_API_KEY, or run with SCOUT_SECRET (and SCOUT_DB_PATH if non-default) so the saved key in settings can be decrypted.');
  process.exit(1);
}
const deepseekModel = process.env.SCOUT_OPENROUTER_MODEL?.trim() || 'deepseek/deepseek-v4-flash';
const key = apiKey as string;

interface RelevanceCase {
  name: string;
  query: string;
  title: string;
  condition?: string;
  imageUrl?: string | null;
}

// Curated to span: clear hit, accessory, parts-only, unrelated, ambiguous.
const relevanceCases: RelevanceCase[] = [
  { name: 'rel-hit', query: 'LEGO Technic 42115', title: 'LEGO Technic Lamborghini Sian 42115 komplet', condition: 'very-good' },
  { name: 'rel-accessory', query: 'iPhone 13', title: 'Etui i pasek do iPhone 13, nowe', condition: 'new' },
  { name: 'rel-parts', query: 'ThinkPad T480', title: 'ThinkPad T480 na części, uszkodzona płyta główna', condition: 'for-parts' },
  { name: 'rel-unrelated', query: 'RTX 3060', title: 'Rower górski Kross, rama 19 cali', condition: 'good' },
  { name: 'rel-broken-motherboard', query: 'rtx 3070', title: 'Uszkodzona płyta główna Lenovo Legion 5 Pro 16IAH7H RTX 3070 Ti – dawca części', condition: 'Uszkodzone' },
  { name: 'rel-bundle', query: 'PS5', title: 'Konsola PS5 + 2 pady + 5 gier, zestaw', condition: 'like-new' },
  { name: 'rel-ambiguous', query: 'Dyson V11', title: 'Odkurzacz Dyson, mocny, sprawny', condition: 'good' },
];

interface VerificationCase {
  name: string;
  title: string;
  condition?: string;
  description: string | null;
}

const verificationCases: VerificationCase[] = [
  { name: 'ver-pass', title: 'Pralka Bosch WAN28259PL', condition: 'very-good', description: 'Pralka w pełni sprawna, cicha, program krótki działa. Sprzedaję z powodu przeprowadzki. Odbiór osobisty.' },
  { name: 'ver-reject', title: 'Telewizor Samsung 55 cali', condition: 'acceptable', description: 'Matryca pęknięta w rogu, brak obrazu w połowie ekranu. Poza tym dźwięk działa. Na części lub do naprawy.' },
  { name: 'ver-ambiguous', title: 'Laptop Dell XPS 13', condition: 'good', description: 'Laptop ok, bateria słaba. Cena do negocjacji!!!' },
  { name: 'ver-short', title: 'Ekspres DeLonghi', condition: 'good', description: 'Sprzedam.' },
  { name: 'ver-missing', title: 'Fotel biurowy', condition: 'unknown', description: null },
];

let agree = 0;
let total = 0;
const unsureBands: number[] = [];

console.log(`DeepSeek model: ${deepseekModel}`);
console.log('--- relevance ---');
for (const sample of relevanceCases) {
  const context = {
    marketplace: 'OLX' as const,
    title: sample.title,
    condition: sample.condition,
    location: 'Warszawa',
    query: sample.query,
    includedTerms: '',
    excludedTerms: '',
  };
  const deepseek = await classifyListingRelevanceWithDeepSeek(context, { apiKey: key, model: deepseekModel });
  const jev = await classifyListingRelevanceWithJev(context, { apiKey: key });
  total += 1;
  const match = deepseek.relevant === jev.relevant;
  if (match) agree += 1;
  if (jev.unsure) unsureBands.push(jev.p);
  let extra = '';
  if (jev.unsure) {
    try {
      const vision = await classifyListingRelevanceWithVision(
        { query: sample.query, title: sample.title, condition: sample.condition, imageUrl: sample.imageUrl ?? null },
        { apiKey: key },
      );
      extra = ` vision=${vision.relevant ? 'relevant' : 'irrelevant'}@${vision.confidence.toFixed(2)}/img${vision.imagesSeen}`;
    } catch (error) {
      extra = ` vision=ERROR(${(error instanceof Error ? error.message : String(error)).slice(0, 80)})`;
    }
  }
  console.log(`${sample.name}: deepseek=${deepseek.relevant ? 'relevant' : 'irrelevant'} jev=${jev.relevant ? 'relevant' : 'irrelevant'}@p${jev.p.toFixed(2)}${jev.unsure ? ' UNSURE' : ''}${match ? '' : ' DISAGREE'}${extra}`);
}

console.log('--- verification ---');
for (const sample of verificationCases) {
  const context = { marketplace: 'OLX' as const, title: sample.title, condition: sample.condition, description: sample.description };
  const deepseek = await verifyListingDescriptionWithDeepSeek(context, { apiKey: key, model: deepseekModel });
  const jev = await verifyListingDescriptionWithJev(context, { apiKey: key });
  total += 1;
  const match = deepseek.decision === jev.decision;
  if (match) agree += 1;
  let extra = '';
  if (jev.unsure) {
    try {
      const vision = await verifyListingDescriptionWithVision(
        { marketplace: 'OLX', title: sample.title, condition: sample.condition, description: sample.description, imageUrls: [] },
        { apiKey: key },
      );
      extra = ` vision=${vision.decision}@${vision.confidence.toFixed(2)}/img${vision.imagesSeen}`;
    } catch (error) {
      extra = ` vision=ERROR(${(error instanceof Error ? error.message : String(error)).slice(0, 80)})`;
    }
  }
  console.log(`${sample.name}: deepseek=${deepseek.decision}@${deepseek.confidence.toFixed(2)} jev=${jev.decision}@${jev.confidence === null ? 'null' : jev.confidence.toFixed(2)}${jev.unsure ? ' UNSURE' : ''}${match ? '' : ' DISAGREE'}${extra}`);
}

console.log(`\nAgreement: ${agree}/${total} (${(100 * agree / total).toFixed(1)}%). Unsure relevance p-values: [${unsureBands.map((p) => p.toFixed(2)).join(', ')}]`);
console.log('Tune RELEVANCE_UNSURE_LOW/HIGH and VERIFICATION_MIN_CONFIDENCE in server/jev.ts from the p/confidence values above.');
