export interface NormalizedResyReservation {
  resy_token: string;
  reservation_id?: string;
  venueName: string;
  location: string;
  date: string;
  time: string;
  partySize: number;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function reservationBuckets(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];

  const buckets: unknown[] = [];
  const take = (value: unknown) => {
    if (Array.isArray(value)) buckets.push(...value);
  };

  const reservations = data.reservations;
  if (Array.isArray(reservations)) {
    take(reservations);
  } else if (isRecord(reservations)) {
    take(reservations.upcoming);
    take(reservations.reservations);
    take(reservations.items);
    if (buckets.length === 0) {
      for (const value of Object.values(reservations)) take(value);
    }
  }

  take(data.upcoming);
  take(data.results);
  return buckets;
}

function readReservation(item: unknown): NormalizedResyReservation | null {
  if (!isRecord(item)) return null;
  const nested = isRecord(item.reservation) ? item.reservation : {};
  const venue = isRecord(item.venue) ? item.venue : {};
  const venueLocation = venue.location;
  const location = typeof venueLocation === 'string'
    ? venueLocation
    : isRecord(venueLocation)
      ? asString(venueLocation.name)
      : '';

  const resyToken = asString(item.resy_token)
    || asString(item.token)
    || asString(nested.resy_token);
  if (!resyToken) return null;

  const reservationId = asString(item.reservation_id)
    || asString(item.id)
    || asString(nested.reservation_id)
    || undefined;

  const party = nested.num_seats ?? item.num_seats ?? item.party_size ?? nested.party_size;
  const partySize = typeof party === 'number' ? party : Number(party) || 0;

  return {
    resy_token: resyToken,
    reservation_id: reservationId || undefined,
    venueName: asString(venue.name) || asString(item.venue_name) || 'Resy reservation',
    location,
    date: asString(nested.day) || asString(item.day) || asString(item.date),
    time: asString(nested.time_slot) || asString(item.time_slot) || asString(item.time),
    partySize,
    status: asString(item.status) || asString(nested.status) || 'confirmed',
  };
}

/** Accept the array shape and `{ reservations: { upcoming: [...] } }`. */
export function parseResyReservations(data: unknown): NormalizedResyReservation[] {
  const seen = new Set<string>();
  const out: NormalizedResyReservation[] = [];
  for (const item of reservationBuckets(data)) {
    const reservation = readReservation(item);
    if (!reservation || seen.has(reservation.resy_token)) continue;
    seen.add(reservation.resy_token);
    out.push(reservation);
  }
  return out;
}

/** Numeric reservation ids are not cancel tokens. Match either field. */
export function findResyToken(reservations: NormalizedResyReservation[], idOrToken: string): string | null {
  const needle = idOrToken.trim();
  if (!needle) return null;
  const match = reservations.find((reservation) =>
    reservation.resy_token === needle || reservation.reservation_id === needle
  );
  return match?.resy_token ?? ( /^\d+$/.test(needle) ? null : needle );
}
