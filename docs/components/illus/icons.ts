// Line icons for the illustrations (16 × 16, drawn with the current color).
export const ICONS = {
  browser: '<rect x="1.5" y="2.5" width="13" height="11"/><path d="M1.5 5.5h13"/>',
  phone: '<rect x="4.5" y="1.5" width="7" height="13"/><path d="M7.5 12.2h1"/>',
  tablet: '<rect x="3" y="1.5" width="10" height="13"/><path d="M7.5 12.2h1"/>',
  server: '<rect x="2" y="2" width="12" height="5"/><rect x="2" y="9" width="12" height="5"/><path d="M4.5 4.5h1M4.5 11.5h1"/>',
  database: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9"/><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
  globe: '<circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c2.2 2.3 2.2 10.7 0 13M8 1.5c-2.2 2.3-2.2 10.7 0 13"/>',
  store: '<path d="M2.5 6.5h11v8h-11z"/><path d="M1.5 6.5l1.5-4h10l1.5 4"/><path d="M6.5 14.5v-4h3v4"/>',
  console: '<rect x="1.5" y="2.5" width="13" height="11"/><path d="M4 6.5l2 1.5-2 1.5M7.5 10.5h4"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  bolt: '<path d="M9 1.5L3.5 9h4L7 14.5 12.5 7h-4z"/>',
  devices: '<rect x="1.5" y="3.5" width="6" height="11"/><rect x="9" y="1.5" width="5.5" height="9"/>',
  flag: '<path d="M3.5 14.5V2"/><path d="M3.5 2.5h9l-2 3 2 3h-9"/>',
  cloud: '<path d="M4.5 12.5h7.5a3 3 0 0 0 .4-6 4.5 4.5 0 0 0-8.6 1.2A2.4 2.4 0 0 0 4.5 12.5z"/>',
  users: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 14c.5-2.6 2.2-4 4.5-4s4 1.4 4.5 4"/><path d="M11 3.2a2.4 2.4 0 0 1 0 4.6M12.5 10.3c1.2.6 1.9 1.8 2 3.7"/>',
  lock: '<rect x="3" y="7" width="10" height="7.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
} satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;
