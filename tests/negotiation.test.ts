import test from 'node:test';
import assert from 'node:assert/strict';
import { offerCeiling, openingDiscountForNegotiation, recommendNegotiationPrice } from '../server/negotiation';

test('uses a fixed opening discount below a hard total-cost ceiling', () => {
  const result = recommendNegotiationPrice({
    askingPrice: 2200,
    priceNegotiable: true,
    maxTotalCost: 2150,
    shippingCost: 50,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.ceilingPrice, 2100);
  assert.equal(result.openingOffer, 1935);
  assert.deepEqual(result.counterOffers, [2015, 2065, 2100]);
  assert.equal(result.openingOffer! < result.askingPrice, true);
  assert.equal(result.openingOffer! <= result.ceilingPrice!, true);
  assert.equal(openingDiscountForNegotiation(), 0.12);
});

test('does not soften the opening offer for a listing that is already a great deal', () => {
  const result = recommendNegotiationPrice({
    askingPrice: 1900,
    priceNegotiable: true,
    maxTotalCost: 1950,
    shippingCost: 50,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.openingOffer, 1670);
});

test('works without a learned baseline but still requires a buyer budget', () => {
  const result = recommendNegotiationPrice({ askingPrice: 1000, priceNegotiable: true, maxTotalCost: 1200 });
  assert.equal(result.status, 'ready');
  assert.equal(result.openingOffer, 880);
  assert.equal(recommendNegotiationPrice({ askingPrice: 1000, priceNegotiable: true, maxTotalCost: null }).status, 'budget-required');
  const fixedPrice = recommendNegotiationPrice({ askingPrice: 1000, priceNegotiable: false, maxTotalCost: 900 });
  assert.equal(fixedPrice.status, 'not-negotiable');
  assert.equal(fixedPrice.openingOffer, 880);
  const unspecified = recommendNegotiationPrice({ askingPrice: 1000, priceNegotiable: null, maxTotalCost: 900 });
  assert.equal(unspecified.status, 'manual-review');
  assert.equal(unspecified.openingOffer, 880);
  assert.match(unspecified.rationale, /not specified/);
});

test('calculates the ceiling after known costs and never allows an offer above asking', () => {
  assert.equal(offerCeiling(2150, 2200, 50, 25), 2075);
  assert.equal(offerCeiling(2500, 2200, 50, 25), 2200);
});

test('accepts a bounded opening discount policy for automatic negotiation', () => {
  const result = recommendNegotiationPrice({ askingPrice: 1000, priceNegotiable: true, maxTotalCost: 1000, openingDiscountPercent: 20 });
  assert.equal(result.openingOffer, 800);
  assert.equal(openingDiscountForNegotiation(20), 0.2);
  assert.throws(() => openingDiscountForNegotiation(0), /between 1% and 50%/);
});

test('a reference band can only tighten the ceiling, never loosen it', () => {
  // Band high below asking: ceiling is capped at the band, math recomputes from the smaller room.
  const capped = recommendNegotiationPrice({ askingPrice: 2000, priceNegotiable: true, maxTotalCost: 3000, fairPriceBand: { low: 1200, high: 1500 } });
  assert.equal(capped.ceilingPrice, 1500);
  assert.equal(capped.openingOffer, 1500);
  assert.ok(capped.openingOffer! <= capped.ceilingPrice!);
  assert.ok(capped.openingOffer! < capped.askingPrice);
  assert.match(capped.rationale, /probable-sale band/);

  // Band above asking: behaviour is identical to no band at all.
  const uncapped = recommendNegotiationPrice({ askingPrice: 2000, priceNegotiable: true, maxTotalCost: 3000, fairPriceBand: { low: 1800, high: 2600 } });
  const plain = recommendNegotiationPrice({ askingPrice: 2000, priceNegotiable: true, maxTotalCost: 3000 });
  assert.equal(uncapped.ceilingPrice, plain.ceilingPrice);
  assert.equal(uncapped.openingOffer, plain.openingOffer);
  assert.doesNotMatch(plain.rationale, /probable-sale band/);
  assert.doesNotMatch(uncapped.rationale, /probable-sale band/);

  // A very thin band still yields a positive, below-asking offer inside the ceiling.
  const thin = recommendNegotiationPrice({ askingPrice: 2000, priceNegotiable: true, maxTotalCost: 3000, fairPriceBand: { low: 10, high: 12 } });
  assert.equal(thin.status, 'ready');
  assert.equal(thin.openingOffer, 10);
  assert.equal(thin.ceilingPrice, 12);
});
