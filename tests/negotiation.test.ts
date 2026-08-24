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
