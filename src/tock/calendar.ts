/** Worker-native decoder for Tock's ConsumerFullCalendarV2 MessageSet.
 * Protocol reference: mvanhorn/printing-press-library, internal/source/tock/calendar.go.
 * No browser, native transport, or runtime dependencies.
 */
type Field = { id: number; wire: number; value: number | Uint8Array | Field[] };

function fields(bytes: Uint8Array): Field[] {
  let pos = 0;
  const read = (): number => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (pos >= bytes.length) throw new Error('Tock protobuf: truncated varint');
      const byte = bytes[pos++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Tock protobuf: integer overflow');
        return Number(value);
      }
    }
    throw new Error('Tock protobuf: invalid varint');
  };
  const group = (end?: number, depth = 0): Field[] => {
    if (depth > 16) throw new Error('Tock protobuf: nesting limit');
    const result: Field[] = [];
    while (pos < bytes.length) {
      const tag = read(), id = Math.floor(tag / 8), wire = tag % 8;
      if (!id) throw new Error('Tock protobuf: invalid field');
      if (wire === 4) {
        if (end !== id) throw new Error('Tock protobuf: mismatched group');
        return result;
      }
      let value: Field['value'];
      if (wire === 0) value = read();
      else if (wire === 3) value = group(id, depth + 1);
      else if (wire === 1 || wire === 2 || wire === 5) {
        const length = wire === 2 ? read() : wire === 1 ? 8 : 4;
        if (length > bytes.length - pos) throw new Error('Tock protobuf: truncated bytes');
        value = bytes.subarray(pos, pos + length); pos += length;
      } else throw new Error('Tock protobuf: unsupported wire type');
      result.push({ id, wire, value });
    }
    if (end !== undefined) throw new Error('Tock protobuf: unterminated group');
    return result;
  };
  return group();
}

const nested = (f?: Field): Field[] => f?.value instanceof Uint8Array ? fields(f.value) : Array.isArray(f?.value) ? f.value : [];
const first = (fs: Field[], id: number) => fs.find(f => f.id === id);
const text = (f?: Field) => f?.value instanceof Uint8Array ? new TextDecoder().decode(f.value) : '';
const number = (f?: Field) => typeof f?.value === 'number' ? f.value : 0;

export interface CalendarSlot {
  date: string;
  time: string;
  available: number;
  minParty: number;
  maxParty: number;
  experienceIds: string[];
}

export function decodeCalendar(bytes: Uint8Array): CalendarSlot[] {
  const envelope = fields(bytes);
  // Accept both ordinary extension encoding and the proto2 MessageSet wrapper.
  let payload = first(envelope, 60686);
  for (const item of envelope.filter(f => f.id === 1 && f.wire === 3)) {
    const group = nested(item);
    if (number(first(group, 2)) === 60686) payload = first(group, 3);
  }
  if (!payload) throw new Error('Tock calendar: unexpected protobuf response (missing ConsumerFullCalendarV2)');
  const slots: CalendarSlot[] = [];
  for (const businessDay of nested(payload).filter(f => f.id === 1)) {
    const dayMap = nested(businessDay);
    for (const dateEntry of nested(first(dayMap, 2)).filter(f => f.id === 1)) {
      const dateMap = nested(dateEntry), date = text(first(dateMap, 1));
      for (const ticket of nested(first(dateMap, 2)).filter(f => f.id === 2)) {
        const fs = nested(ticket);
        const slotDate = text(first(fs, 1)) || date;
        const time = text(first(fs, 3));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(slotDate) || !/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) {
          throw new Error('Tock calendar: invalid slot date/time');
        }
        const experienceIds = fs.filter(f => f.id === 13).flatMap(f => nested(f)
          .filter(e => e.id === 1 && e.wire === 0).map(e => String(e.value)));
        slots.push({ date: slotDate, time: time.slice(0, 5), available: number(first(fs, 5)),
          minParty: number(first(fs, 9)), maxParty: number(first(fs, 19)), experienceIds });
      }
    }
  }
  return slots;
}

export interface TockBootstrap { businessId: string; name?: string; jwt?: string; build?: string }

export function bootstrapFromHtml(html: string, slug: string): TockBootstrap {
  const marker = /(?:window\.)?\$REDUX_STATE\s*=\s*/g.exec(html);
  if (!marker) throw new Error('Tock venue page has no Redux state');
  const start = html.indexOf('{', marker.index + marker[0].length);
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; start >= 0 && i < html.length; i++) {
    const char = html[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === '{') depth++;
    if (!quoted && char === '}' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('Tock venue page has incomplete Redux state');
  let state: any;
  try { state = JSON.parse(html.slice(start, end)); }
  catch { throw new Error('Tock venue state is not JSON; bootstrap format may have changed'); }
  const app = state?.app, business = app?.config?.business;
  if (!business?.id || (business.domainName && business.domainName !== slug)) {
    throw new Error('Tock venue page has no matching business');
  }
  return { businessId: String(business.id), name: business.name,
    jwt: typeof app.jwtToken === 'string' ? app.jwtToken : undefined,
    build: html.match(/\/static\/([A-Za-z0-9._-]+)\//)?.[1] };
}
