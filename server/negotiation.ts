export type NegotiationRecommendationStatus =
  | 'ready'
  | 'budget-required'
  | 'not-negotiable'
  | 'manual-review'
  | 'budget-too-low'
  | 'no-room';

export interface NegotiationRecommendationInput {
  askingPrice: number;
  priceNegotiable: boolean | null;
  maxTotalCost: number | null;
  shippingCost?: number;
  otherCosts?: number;
  openingDiscountPercent?: number;
}

export interface NegotiationRecommendation {
  status: NegotiationRecommendationStatus;
  askingPrice: number;
  maxTotalCost: number | null;
  knownCosts: number;
  ceilingPrice: number | null;
  openingOffer: number | null;
  counterOffers: number[];
  openingDiscountPercent: number | null;
  rationale: string;
}

const DEFAULT_OPENING_DISCOUNT_PERCENT = 12;
const MIN_OPENING_DISCOUNT_PERCENT = 1;
const MAX_OPENING_DISCOUNT_PERCENT = 50;

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function floorToFive(value: number) {
  return Math.floor(value / 5) * 5;
}

export function openingDiscountForNegotiation(openingDiscountPercent = DEFAULT_OPENING_DISCOUNT_PERCENT) {
  if (!Number.isFinite(openingDiscountPercent) || openingDiscountPercent < MIN_OPENING_DISCOUNT_PERCENT || openingDiscountPercent > MAX_OPENING_DISCOUNT_PERCENT) {
    throw new Error(`The opening discount must be between ${MIN_OPENING_DISCOUNT_PERCENT}% and ${MAX_OPENING_DISCOUNT_PERCENT}%.`);
  }
  return openingDiscountPercent / 100;
}

function baseRecommendation(input: NegotiationRecommendationInput, status: NegotiationRecommendationStatus, rationale: string): NegotiationRecommendation {
  const shippingCost = input.shippingCost ?? 0;
  const otherCosts = input.otherCosts ?? 0;
  return {
    status,
    askingPrice: money(input.askingPrice),
    maxTotalCost: input.maxTotalCost === null ? null : money(input.maxTotalCost),
    knownCosts: money(shippingCost + otherCosts),
    ceilingPrice: null,
    openingOffer: null,
    counterOffers: [],
    openingDiscountPercent: null,
    rationale,
  };
}

export function recommendNegotiationPrice(input: NegotiationRecommendationInput): NegotiationRecommendation {
  if (!Number.isFinite(input.askingPrice) || input.askingPrice <= 0) {
    throw new Error('The listing asking price must be positive.');
  }
  const shippingCost = input.shippingCost ?? 0;
  const otherCosts = input.otherCosts ?? 0;
  if (![shippingCost, otherCosts].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Known negotiation costs must be zero or positive.');
  }
  if (input.maxTotalCost !== null && (!Number.isFinite(input.maxTotalCost) || input.maxTotalCost <= 0)) {
    throw new Error('The maximum total cost must be positive when provided.');
  }
  const openingDiscount = openingDiscountForNegotiation(input.openingDiscountPercent);

  if (input.maxTotalCost === null) {
    return baseRecommendation(input, 'budget-required', 'Set a maximum total cost, including delivery and fees, before Scout calculates an offer.');
  }

  const askingPrice = money(input.askingPrice);
  const knownCosts = money(shippingCost + otherCosts);
  const affordablePrice = money(input.maxTotalCost - knownCosts);
  const ceilingPrice = money(Math.min(askingPrice, affordablePrice));
  const status = input.priceNegotiable === true
    ? 'ready'
    : input.priceNegotiable === false
      ? 'not-negotiable'
      : 'manual-review';
  const result = baseRecommendation(input, status, '');
  result.ceilingPrice = ceilingPrice;

  if (ceilingPrice <= 0) {
    result.status = 'budget-too-low';
    result.rationale = 'The maximum total cost does not cover the known delivery and fee costs.';
    return result;
  }

  const desiredOffer = askingPrice * (1 - openingDiscount);
  const maximumBelowAsking = money(askingPrice - 0.01);
  const constrainedOffer = Math.min(desiredOffer, ceilingPrice, maximumBelowAsking);
  let openingOffer = floorToFive(constrainedOffer);
  if (openingOffer <= 0) openingOffer = money(constrainedOffer);
  if (openingOffer <= 0 || openingOffer >= askingPrice) {
    result.status = 'no-room';
    result.rationale = 'There is not enough room below the current asking price to make a valid opening offer.';
    return result;
  }

  result.openingOffer = money(openingOffer);
  result.openingDiscountPercent = ((askingPrice - result.openingOffer) / askingPrice) * 100;
  const remainingRoom = ceilingPrice - result.openingOffer;
  const counterOffers = [
    floorToFive(result.openingOffer + remainingRoom * 0.5),
    floorToFive(result.openingOffer + remainingRoom * 0.8),
    floorToFive(ceilingPrice),
  ].map(money).filter((offer, index, values) => offer > result.openingOffer! && offer <= ceilingPrice && values.indexOf(offer) === index);
  result.counterOffers = counterOffers;
  const priceRationale = `The opening offer is ${result.openingDiscountPercent.toFixed(1)}% below the current asking price and stays below your ${ceilingPrice.toLocaleString('pl-PL')} zł ceiling.`;
  const reviewRationale = input.priceNegotiable === null
    ? 'Negotiability is not specified, so review this suggested price manually before contacting the seller.'
    : input.priceNegotiable === false
      ? 'The seller marked the price as fixed, so treat this as a reference price and do not send a negotiation message automatically.'
      : '';
  result.rationale = [reviewRationale, priceRationale].filter(Boolean).join(' ');
  return result;
}

export function offerCeiling(maxTotalCost: number, askingPrice: number, shippingCost = 0, otherCosts = 0) {
  if (![maxTotalCost, askingPrice, shippingCost, otherCosts].every(Number.isFinite)) throw new Error('Offer budget values must be finite numbers.');
  if (maxTotalCost <= 0 || askingPrice <= 0 || shippingCost < 0 || otherCosts < 0) throw new Error('Offer budget values are out of range.');
  return money(Math.max(0, Math.min(askingPrice, maxTotalCost - shippingCost - otherCosts)));
}
