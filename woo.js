// Reads products from your WooCommerce shop for the Stock tab (1.26.0), with a read-only REST API key
// (WooCommerce → Settings → Advanced → REST API → Add key, Permissions: Read).
//
// The key stays on this computer: it's saved in <userData>/woocommerce.json, the secret encrypted by
// the operating system (safeStorage), and it's never synced or shared with a team. Invaro only ever
// reads (GET) from the shop, over HTTPS.
//
// products() returns every published (or private) product as one row, and each variation of a
// variable product as a row of its own, e.g. "T-shirt - Large, Blue":
//   { wooId, name, sku, category, price, stock (a number, or null when the shop doesn't count it), image (its picture's address) }
// with the shop's currency. image(url) fetches one picture (the renderer makes the thumbnail).
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const CONFIG = () => path.join(app.getPath('userData'), 'woocommerce.json');
const API = '/wp-json/wc/v3';

function read() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG(), 'utf8'));
    if (c.secret) c.secret = safeStorage.decryptString(Buffer.from(c.secret, 'base64'));
    return c;
  } catch (e) { return {}; }
}
function write(c) {
  fs.mkdirSync(path.dirname(CONFIG()), { recursive: true });
  const out = { ...c, secret: c.secret ? safeStorage.encryptString(c.secret).toString('base64') : '' };
  fs.writeFileSync(CONFIG(), JSON.stringify(out, null, 2));
}

// "shop.example.com/", "https://shop.example.com/wp-admin" → "https://shop.example.com"
function siteUrl(s) {
  s = String(s || '').trim();
  if (!s) throw new Error('Type your website address, e.g. https://shop.example.com');
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { throw new Error(`"${s}" isn't a website address.`); }
  if (u.protocol !== 'https:') throw new Error('Your shop needs to use https:// so the key is sent safely.');
  const p = u.pathname.replace(/\/(wp-admin|wp-json|shop)(\/.*)?$/i, '').replace(/\/+$/, '');
  return u.origin + p;
}

async function get(c, p, query = {}) {
  const u = new URL(c.site + API + p);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const auth = 'Basic ' + Buffer.from(`${c.key}:${c.secret}`).toString('base64');
  let res = await fetch(u, { headers: { Authorization: auth, Accept: 'application/json' } });
  // Some web hosts drop the Authorization header; WooCommerce also takes the key in the address (HTTPS only).
  if (res.status === 401) {
    const u2 = new URL(u); u2.searchParams.set('consumer_key', c.key); u2.searchParams.set('consumer_secret', c.secret);
    res = await fetch(u2, { headers: { Accept: 'application/json' } });
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  if (!res.ok || json == null) {
    if (res.status === 404 || (res.ok && json == null)) throw new Error(`${c.site} doesn't look like a WooCommerce shop (no ${API}). Check the address, and that WooCommerce is installed.`);
    if (res.status === 401 || res.status === 403) throw new Error(`Your shop didn't accept the key (${(json && json.message) || res.status}). Check the consumer key and secret, and that the key can Read.`);
    throw new Error(`Your shop said: ${(json && json.message) || res.statusText || res.status}`);
  }
  return { json, pages: Number(res.headers.get('x-wp-totalpages')) || 1 };
}

async function allPages(c, p, query = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const { json, pages } = await get(c, p, { per_page: 100, page, ...query });
    out.push(...json);
    if (page >= pages || !json.length) return out;
  }
}

async function currency(c) {
  try { const { json } = await get(c, '/data/currencies/current'); return json.code || ''; } catch (e) { return ''; }
}

const num = v => v === '' || v == null || isNaN(Number(v)) ? null : Number(v);
const stockOf = p => p.manage_stock && p.stock_quantity != null ? Number(p.stock_quantity) : null;
const LIVE = ['publish', 'private'];
const pictureOf = p => (p.images && p.images[0] && p.images[0].src) || '';
const MAX_PICTURE = 8 * 1024 * 1024;

function createWoo() {
  function status() {
    const c = read();
    return { site: c.site || '', connected: !!(c.site && c.key && c.secret), currency: c.currency || '', lastImport: c.lastImport || null, keyEnd: c.key ? c.key.slice(-4) : '' };
  }
  // Checks the key works before keeping it.
  async function connect(site, key, secret) {
    key = String(key || '').trim(); secret = String(secret || '').trim();
    const old = read();
    if (!secret && old.key === key) secret = old.secret || ''; // reconnecting with the saved secret
    if (!/^ck_\w+$/.test(key)) throw new Error('The consumer key starts with ck_. Copy it from WooCommerce → Settings → Advanced → REST API.');
    if (!/^cs_\w+$/.test(secret)) throw new Error('The consumer secret starts with cs_. WooCommerce only shows it once, when you make the key.');
    const c = { site: siteUrl(site), key, secret };
    await get(c, '/products', { per_page: 1 });
    c.currency = await currency(c);
    write(c);
    return status();
  }
  function disconnect() { try { fs.unlinkSync(CONFIG()); } catch (e) {} return status(); }

  async function products() {
    const c = read();
    if (!c.site || !c.key || !c.secret) throw new Error('Connect your WooCommerce shop first.');
    const cur = await currency(c) || c.currency || '';
    const list = (await allPages(c, '/products')).filter(p => LIVE.includes(p.status));
    const rows = [];
    const variable = [];
    for (const p of list) {
      const category = (p.categories || []).map(x => x.name).filter(Boolean)[0] || '';
      if (p.type === 'variable') { variable.push({ p, category }); continue; }
      if (p.type === 'grouped' || p.type === 'external') continue; // nothing of your own to stock
      rows.push({ wooId: String(p.id), name: p.name || '', sku: p.sku || '', category, price: num(p.price) ?? num(p.regular_price), stock: stockOf(p), image: pictureOf(p) });
    }
    // A variable product's variations, a few at a time.
    for (let i = 0; i < variable.length; i += 4) {
      const batch = await Promise.all(variable.slice(i, i + 4).map(async ({ p, category }) => ({ p, category, vars: await allPages(c, `/products/${p.id}/variations`) })));
      for (const { p, category, vars } of batch) {
        for (const v of vars) {
          if (v.status && !LIVE.includes(v.status)) continue;
          const opts = (v.attributes || []).map(a => a.option).filter(Boolean).join(', ');
          // A variation without its own stock count shares the product's.
          const stock = v.manage_stock === 'parent' ? stockOf(p) : stockOf(v);
          rows.push({ wooId: `${p.id}/${v.id}`, name: opts ? `${p.name} - ${opts}` : p.name, sku: v.sku || '', category, price: num(v.price) ?? num(v.regular_price), stock, image: (v.image && v.image.src) || pictureOf(p) });
        }
      }
    }
    write({ ...c, currency: cur || c.currency || '', lastImport: new Date().toISOString() });
    // Entities like &amp; come through in product names.
    const unescape = s => String(s).replace(/&amp;/g, '&').replace(/&#0?38;/g, '&').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    return { currency: cur, site: c.site, rows: rows.map(r => ({ ...r, name: unescape(r.name), category: unescape(r.category) })) };
  }
  // One product picture as a data URL. Pictures are public on your shop, so no key is sent.
  async function image(url) {
    let u;
    try { u = new URL(String(url)); } catch (e) { throw new Error('Not a picture address.'); }
    if (u.protocol !== 'https:') throw new Error('Pictures are only fetched over https://');
    const res = await fetch(u, { headers: { Accept: 'image/*' } });
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok) throw new Error(`Couldn't get the picture (${res.status}).`);
    if (!/^image\//.test(type)) throw new Error("That address isn't a picture.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PICTURE) throw new Error('That picture is too big (over 8 MB).');
    return `data:${type};base64,${buf.toString('base64')}`;
  }
  return { status, connect, disconnect, products, image };
}

module.exports = { createWoo, siteUrl };
