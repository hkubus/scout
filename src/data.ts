import type { Connector, DashboardData, Listing, Marketplace, Watch } from './types';

const svg = (body: string, bg = '#f4f6f8') =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" rx="14" fill="${bg}"/>${body}</svg>`)}`;

export const thumbnails = {
  deck: svg('<rect x="26" y="30" width="108" height="40" rx="10" fill="#202833"/><rect x="36" y="38" width="74" height="24" rx="4" fill="#0d1a22"/><rect x="43" y="42" width="60" height="16" rx="3" fill="#2e88b8"/><circle cx="126" cy="42" r="6" fill="#687482"/><circle cx="126" cy="58" r="6" fill="#687482"/><path d="M29 68h102" stroke="#718091" stroke-width="3" stroke-linecap="round"/>', '#e8edf3'),
  deck2: svg('<rect x="23" y="31" width="114" height="39" rx="10" fill="#232d37"/><rect x="38" y="38" width="67" height="24" rx="4" fill="#101b2e"/><rect x="43" y="42" width="56" height="16" rx="3" fill="#ae3e6d"/><circle cx="126" cy="42" r="6" fill="#6f7c86"/><circle cx="126" cy="58" r="6" fill="#6f7c86"/>', '#edf1f5'),
  headphones: svg('<path d="M48 58V45c0-20 12-31 32-31s32 11 32 31v13" fill="none" stroke="#20242b" stroke-width="10" stroke-linecap="round"/><rect x="43" y="52" width="18" height="30" rx="8" fill="#313842"/><rect x="99" y="52" width="18" height="30" rx="8" fill="#313842"/><path d="M47 75h13M100 75h13" stroke="#a5adb7" stroke-width="3"/>', '#eceff2'),
  lego: svg('<path d="M28 71l12-26 20 6 8-26 23 4 8 20 22 4 10 23z" fill="#b8a46d"/><path d="M44 46h26v25H34zM77 31h20v40H69zM106 50h21v21h-28z" fill="#d5b246"/><path d="M36 60h12v10H36zM78 46h11v11H78zM107 58h10v9h-10z" fill="#7f5345"/><path d="M29 72h101" stroke="#74633e" stroke-width="3"/>', '#f4f0e5'),
  jacket: svg('<path d="M61 19l19-6 19 6 15 20-11 9-8-12v39H45V36l-8 12-11-9 15-20z" fill="#343b3e"/><path d="M80 13v53M63 17l17 16 17-16" fill="none" stroke="#6d7678" stroke-width="3"/><rect x="50" y="44" width="12" height="6" rx="3" fill="#5d6668"/><rect x="98" y="44" width="12" height="6" rx="3" fill="#5d6668"/>', '#e9ecee'),
  controller: svg('<path d="M40 37c5-7 13-10 23-6l17 6 17-6c10-4 18-1 23 6 7 10 9 26 1 31-9 6-14-8-22-15H63c-8 7-13 21-22 15-8-5-6-21-1-31z" fill="#f4f4f4" stroke="#afb5ba" stroke-width="3"/><path d="M55 45v16M47 53h16M104 47h1M113 54h1" stroke="#4f5962" stroke-width="4" stroke-linecap="round"/>', '#eef1f4'),
} as const;

export const listings: Listing[] = [
  { id: 'olx-890231', title: 'Steam Deck OLED 512GB', subtitle: 'Jak nowa, etui', marketplace: 'OLX', price: 1899, typical: 2999, belowTypical: -36.7, observed: '1m ago', observedAt: '10:24:18', dealStrength: 5, dealLabel: 'Exceptional', image: thumbnails.deck, url: 'https://www.olx.pl/d/oferta/steam-deck-oled-512gb-CID99-ID123456.html', watch: 'Steam Deck OLED 512GB', condition: 'Like new', location: 'Warszawa', shippingAvailable: true },
  { id: 'al-344821', title: 'Sony WH-1000XM5', subtitle: 'Czarne, stan idealny', marketplace: 'Allegro Lokalnie', price: 749, typical: 1199, belowTypical: -37.5, observed: '3m ago', observedAt: '10:22:02', dealStrength: 5, dealLabel: 'Exceptional', image: thumbnails.headphones, url: 'https://allegrolokalnie.pl/oferta/sony-wh-1000xm5-12345', watch: 'Sony WH-1000XM5', condition: 'Like new', location: 'Kraków', shippingAvailable: true },
  { id: 'al-991120', title: 'LEGO 10316 Rivendell', subtitle: 'Komplet, pudełko', marketplace: 'Allegro Lokalnie', price: 1149, typical: 1699, belowTypical: -32.4, observed: '5m ago', observedAt: '10:20:31', dealStrength: 5, dealLabel: 'Very strong', image: thumbnails.lego, url: 'https://allegrolokalnie.pl/oferta/lego-10316-rivendell-991120', watch: 'LEGO Rivendell', condition: 'Very good', location: 'Gdańsk', shippingAvailable: true },
  { id: 'olx-778433', title: 'Steam Deck 64GB (LCD)', subtitle: 'Dobry stan', marketplace: 'OLX', price: 1199, typical: 1599, belowTypical: -25.0, observed: '12m ago', observedAt: '10:13:14', dealStrength: 4, dealLabel: 'Strong', image: thumbnails.deck2, url: 'https://www.olx.pl/d/oferta/steam-deck-64gb-lcd-CID99-ID778433.html', watch: 'Steam Deck 64GB', condition: 'Good', location: 'Poznań', shippingAvailable: false },
  { id: 'vin-220932', title: 'Carhartt WIP Detroit Jacket', subtitle: 'Rozm. M, czarna', marketplace: 'Vinted', price: 419, typical: 549, belowTypical: -23.7, observed: '15m ago', observedAt: '10:10:44', dealStrength: 4, dealLabel: 'Strong', image: thumbnails.jacket, url: 'https://www.vinted.pl/items/220932-carhartt-wip-detroit-jacket', watch: 'Carhartt Detroit Jacket', condition: 'Very good', location: 'Łódź', shippingAvailable: true },
  { id: 'olx-445900', title: 'Xbox Elite Series 2 Controller', subtitle: 'Stan dobry', marketplace: 'OLX', price: 499, typical: 649, belowTypical: -23.1, observed: '22m ago', observedAt: '10:03:09', dealStrength: 4, dealLabel: 'Strong', image: thumbnails.controller, url: 'https://www.olx.pl/d/oferta/xbox-elite-series-2-CID99-ID445900.html', watch: 'Xbox Elite Series 2 Controller', condition: 'Good', location: 'Wrocław', shippingAvailable: true },
];

export const watches: Watch[] = [
  { id: 'watch-deck', name: 'Steam Deck OLED 512GB', query: 'steam deck oled 512gb', terms: 'oled, 512gb', excluded: 'broken, parts', sources: ['OLX', 'Allegro Lokalnie'], location: 'Polska', condition: 'Any', samples: 84, targetSamples: 100, observationHours: 31, readiness: 84, status: 'Learning', interval: 5, nextScan: 'in 4m', enabled: true, exactUrls: [], sensitivity: 1, shippingOnly: false, aiRelevance: true, minPrice: null, maxPrice: null },
  { id: 'watch-sony', name: 'Sony WH-1000XM5', query: 'sony wh-1000xm5', terms: 'xm5', excluded: 'fake, replica', sources: ['OLX', 'Allegro Lokalnie', 'Vinted'], location: 'Polska', condition: 'Very good+', samples: 61, targetSamples: 100, observationHours: 28, readiness: 61, status: 'Learning', interval: 5, nextScan: 'in 4m', enabled: true, exactUrls: [], sensitivity: 1, shippingOnly: false, aiRelevance: true, minPrice: null, maxPrice: null },
  { id: 'watch-lego', name: 'LEGO 10316 Rivendell', query: 'lego 10316 rivendell', terms: '10316, rivendell', excluded: 'instructions only', sources: ['OLX', 'Allegro Lokalnie'], location: 'Polska', condition: 'Any', samples: 118, targetSamples: 120, observationHours: 52, readiness: 98, status: 'Ready', interval: 10, nextScan: 'in 7m', enabled: true, exactUrls: [], sensitivity: 1, shippingOnly: false, aiRelevance: true, minPrice: null, maxPrice: null },
  { id: 'watch-xbox', name: 'Xbox Elite Series 2 Controller', query: 'xbox elite series 2 controller', terms: 'elite, series 2', excluded: 'parts, shell', sources: ['OLX', 'Vinted'], location: 'Polska', condition: 'Good+', samples: 42, targetSamples: 100, observationHours: 24, readiness: 42, status: 'Learning', interval: 5, nextScan: 'in 2m', enabled: true, exactUrls: [], sensitivity: 1, shippingOnly: false, aiRelevance: true, minPrice: null, maxPrice: null },
  { id: 'watch-carhartt', name: 'Carhartt Detroit Jacket', query: 'carhartt wip detroit jacket', terms: 'detroit, carhartt', excluded: 'kids, replica', sources: ['Vinted', 'OLX'], location: 'Polska', condition: 'Very good+', samples: 96, targetSamples: 100, observationHours: 40, readiness: 94, status: 'Ready', interval: 15, nextScan: 'in 13m', enabled: true, exactUrls: [], sensitivity: 1, shippingOnly: false, aiRelevance: true, minPrice: null, maxPrice: null },
];

export const connectors: Connector[] = [
  { name: 'OLX', kind: 'marketplace', status: 'OK', detail: 'Public search pages reachable', lastSuccess: '1m ago', color: '#159b96', requests: 482, latency: '820 ms' },
  { name: 'Allegro Lokalnie', kind: 'marketplace', status: 'OK', detail: 'Public search pages reachable', lastSuccess: '2m ago', color: '#f27526', requests: 366, latency: '1.1 s' },
  { name: 'Vinted', kind: 'marketplace', status: 'Warning', detail: 'Intermittent challenge page · backing off', lastSuccess: '6m ago', color: '#55a9b0', requests: 290, latency: '2.4 s' },
  { name: 'Discord', kind: 'discord', status: 'OK', detail: 'Webhook destination configured', lastSuccess: '1m ago', color: '#32a85b', requests: 18, latency: '410 ms' },
  { name: 'ntfy', kind: 'ntfy', status: 'Idle', detail: 'Priority-filtered alerts', lastSuccess: 'Never', color: '#4f9da6', requests: 0, latency: '—' },
];

export const dashboardSeed: DashboardData = { listings, watches, connectors, stats: { watching: watches.length, newToday: listings.length, strongDeals: listings.filter((listing) => listing.dealStrength >= 4).length }, lastScan: '1m ago', lastScanTime: '10:24:18' };

export const emptyDashboard: DashboardData = {
  listings: [],
  watches: [],
  connectors: [
    { name: 'OLX', kind: 'marketplace', status: 'Idle', detail: 'No connector run yet', lastSuccess: 'Never', color: '#159b96', requests: 0, latency: '—' },
    { name: 'Allegro Lokalnie', kind: 'marketplace', status: 'Idle', detail: 'No connector run yet', lastSuccess: 'Never', color: '#f27526', requests: 0, latency: '—' },
    { name: 'Vinted', kind: 'marketplace', status: 'Idle', detail: 'No connector run yet', lastSuccess: 'Never', color: '#55a9b0', requests: 0, latency: '—' },
    { name: 'Discord', kind: 'discord', status: 'Idle', detail: 'Webhook not configured', lastSuccess: 'Never', color: '#32a85b', requests: 0, latency: '—' },
    { name: 'ntfy', kind: 'ntfy', status: 'Idle', detail: 'ntfy not configured', lastSuccess: 'Never', color: '#4f9da6', requests: 0, latency: '—' },
  ],
  stats: { watching: 0, newToday: 0, strongDeals: 0 },
  lastScan: 'Never',
  lastScanTime: '—',
};

export const marketplaceColors: Record<Marketplace, string> = {
  OLX: '#159b96',
  'Allegro Lokalnie': '#f27526',
  Vinted: '#55a9b0',
};
