import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = mkdtempSync(path.join(root, 'dist', 'tock-'));
execFileSync('npx', ['--no-install', 'tsc', '--outDir', out, '--declaration', 'false', '--sourceMap', 'false'], { cwd: root, stdio: 'inherit' });
const base = pathToFileURL(out).href;
const { decodeCalendar, bootstrapFromHtml } = await import(`${base}/tock/calendar.js`);
const { TockPlatformClient } = await import(`${base}/platforms/tock.js`);
const { setEnv } = await import(`${base}/env.js`);
const v = n => { const a=[]; do { a.push((n & 127) | (n > 127 ? 128 : 0)); n=Math.floor(n/128); } while(n); return a; };
const num = (id,n) => [...v(id*8),...v(n)];
const msg = (id,data) => [...v(id*8+2),...v(data.length),...data];
const str = (id,s) => msg(id,[...new TextEncoder().encode(s)]);
const slot = (date,time,available,min,max,exp) => msg(2,[...str(1,date),...str(3,time),...num(5,available),...num(9,min),...num(19,max),...msg(13,num(1,exp))]);
const date='2026-11-20';
const payload = msg(1,[...str(1,date),...msg(2,msg(1,[...str(1,date),...msg(2,[
  ...slot(date,'19:00',6,2,6,123),...slot(date,'19:00',6,2,6,456),
  ...slot(date,'20:00',1,1,6,123),...slot(date,'21:00',8,4,8,123),
  ...slot('2026-11-21','19:00',8,1,8,123),
])]))]);
const fixture = Uint8Array.from([...v(11),...num(2,60686),...msg(3,payload),...v(12)]);
const html = `<script src="/static/build-1/explore.js"></script><script>window.$REDUX_STATE = ${JSON.stringify({app:{jwtToken:'anonymous-test-token',config:{business:{id:42,name:'A } restaurant',domainName:'venue'}}}})};</script>`;
const realFetch = globalThis.fetch;
test.beforeEach(() => setEnv({ CREDS: { get: async()=>JSON.stringify({businessId:'42',name:'Venue'}) } }));
test.afterEach(() => { globalThis.fetch=realFetch; });
test('decodes MessageSet and ordinary extension calendar envelopes', () => {
  assert.equal(decodeCalendar(fixture).length,5);
  assert.deepEqual(decodeCalendar(Uint8Array.from(msg(60686,payload))),decodeCalendar(fixture));
  assert.deepEqual(decodeCalendar(Uint8Array.from(msg(60686,[]))),[]);
});
test('rejects truncated, unknown, and malformed protobuf instead of reporting no availability', () => {
  for(const data of [[],[128],[0], [...fixture.slice(0,-1)]]) assert.throws(()=>decodeCalendar(Uint8Array.from(data)));
  assert.throws(()=>decodeCalendar(new TextEncoder().encode('{"error":"auth"}')));
});
test('bootstraps exact venue identity without evaluating page scripts', () => {
  assert.deepEqual(bootstrapFromHtml(html,'venue'),{businessId:'42',name:'A } restaurant',jwt:'anonymous-test-token',build:'build-1'});
  assert.throws(()=>bootstrapFromHtml(html,'wrong'));
  assert.throws(()=>bootstrapFromHtml('window.$REDUX_STATE = {x:undefined};','venue'));
});
test('sends empty binary calendar request and filters date, capacity, party range without merging experiences', async () => {
  let calls=0;
  globalThis.fetch=async(url,init)=>{
    calls++;
    if(String(url).endsWith('/venue')) return new Response(html);
    assert.equal(String(url),'https://www.exploretock.com/api/consumer/calendar/full/v2');
    assert.equal(init.method,'POST');
    assert.equal(init.headers['Content-Type'],'application/octet-stream');
    assert.equal(init.headers['X-Tock-Stream-Format'],'proto2');
    assert.equal(init.headers['X-Tock-Authorization'],'anonymous-test-token');
    assert.equal(init.headers['X-Tock-Scope'],'{"businessId":"42"}');
    assert.equal(init.body.byteLength,0);
    return new Response(fixture,{headers:{'content-type':'application/octet-stream'}});
  };
  const slots=await new TockPlatformClient().getAvailability('venue',date,2);
  assert.equal(calls,2);
  assert.deepEqual(slots.map(s=>s.slotId),[`${date}-19:00-123`,`${date}-19:00-456`]);
});
test('saved business ID still attempts calendar when venue bootstrap is blocked', async () => {
  globalThis.fetch=async(url,init)=>String(url).endsWith('/venue')
    ? new Response('blocked',{status:403,headers:{'cf-mitigated':'challenge'}})
    : (assert.equal(init.headers['X-Tock-Authorization'],undefined),new Response(fixture));
  assert.equal((await new TockPlatformClient().getAvailability('venue',date,2)).length,2);
});
test('surfaces challenge, HTTP, and HTML failures as unknown availability', async () => {
  for(const response of [()=>new Response('blocked',{status:403,headers:{'cf-mitigated':'challenge'}}),()=>new Response('bad',{status:415}),()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}})]) {
    globalThis.fetch=async(url)=>String(url).endsWith('/venue')?new Response(html):response();
    await assert.rejects(()=>new TockPlatformClient().getAvailability('venue',date,2),/challenge|HTTP 415|HTML page/);
  }
});
test('checkout handoff never reports a completed reservation', async () => {
  const result=await new TockPlatformClient().makeReservation({restaurantId:'tock-venue',date,partySize:2,slotId:'slot',platform:'tock'});
  assert.equal(result.success,false);
  assert.match(result.bookingUrl,/exploretock.com\/venue/);
  assert.equal(await new TockPlatformClient().isAuthenticated(),false);
});
