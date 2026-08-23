import type { NormalizedListing } from './marketplaces';

export interface DealNotificationInput {
  listing: NormalizedListing;
  typical: number;
  discountPercent: number;
  confidence: number;
  observedAt?: string;
}

export function buildDiscordEmbed(input: DealNotificationInput) {
  const { listing } = input;
  return {
    username: 'Scout',
    embeds: [{
      title: listing.title,
      url: listing.url,
      color: input.discountPercent >= 30 ? 0xf15a35 : 0xf4b734,
      thumbnail: listing.imageUrl ? { url: listing.imageUrl } : undefined,
      fields: [
        { name: 'Marketplace', value: listing.marketplace, inline: true },
        { name: 'Price', value: `${listing.price.toLocaleString('pl-PL')} zł`, inline: true },
        { name: 'Typical price', value: `${input.typical.toLocaleString('pl-PL')} zł`, inline: true },
        { name: 'Below typical', value: `${input.discountPercent.toFixed(1)}%`, inline: true },
        { name: 'Confidence', value: `${input.confidence}%`, inline: true },
        { name: 'Observed', value: input.observedAt ?? listing.observedAt, inline: true },
      ],
      footer: { text: 'Scout · public-page monitor' },
    }],
  };
}

export function notificationKey(listing: Pick<NormalizedListing, 'marketplace' | 'listingId'>) {
  return `${listing.marketplace}:${listing.listingId}`.toLowerCase();
}
