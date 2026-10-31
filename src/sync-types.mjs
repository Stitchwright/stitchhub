// The message types the v2 queue carries (docs/hub-sync-design.md, shop-orders contract). The hub refuses a type that is not
// here, and refuses it from a sender it is not meant for. Bodies are checked by type in src/sync-orders.mjs.
//   from/to: shop (a program's company), service (MakerFoundry), hub (the hub itself), any
//   days:    the longest a message of this type is kept for delivery; a sender may ask for less
export const TYPES = {
  catalog: { versions: [1], from: "shop", to: "service", days: 14 },
  "order.placed": { versions: [1], from: "service", to: "shop", days: 7 },
  "order.status": { versions: [1], from: "shop", to: "service", days: 14 },
  "proof.sent": { versions: [1], from: "shop", to: "service", days: 14 },
  "proof.answer": { versions: [1], from: "service", to: "shop", days: 14 },
  "order.cancel": { versions: [1], from: "any", to: "any", days: 14 },
  "message.expired": { versions: [1], from: "hub", to: "any", days: 30 },
};

/** The types and versions the hub itself understands, as /v2/hello says them. */
export const hubTypes = () => Object.fromEntries(Object.entries(TYPES).map(([t, s]) => [t, s.versions]));
