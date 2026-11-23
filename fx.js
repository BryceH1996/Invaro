// Banks' exchange rates, for showing invoices in rand in Reports.
//
// Each bank's rate is its buying rate for foreign currency paid to you (what the bank pays in rand),
// read from the bank's own public rates page or feed. Only a date is ever sent.
//   standard  Standard Bank, "Bank Buying T/T". Its page has today's indication rates and every
//             business day's 16:00 closing rates back to 2002 (posting fn=forex<yyyymmdd>_16).
//   absa      Absa, "BuyTransfers", from the rates embedded in its exchange-rates page. Today only.
//   nedbank   Nedbank's rates feed (the one its forex page uses), updated every 15 minutes. Today
//             only. It doesn't name a transfer rate: its cheque buying rate is the one used, as the
//             closest (the page itself shows the bank-note rate).
// (FNB's rates page sits behind a CAPTCHA, and Capitec and Investec don't publish rates.)
//
// Every day's rates that are read are kept in fx-cache.json: Standard Bank's history is fetched once
// per day, and for Absa and Nedbank the kept days become the history, from when Invaro first read them.
const fs = require('fs');

const BANKS = {
  standard: { name: 'Standard Bank', rate: 'T/T buying rate', history: true },
  absa: { name: 'Absa', rate: 'transfer buying rate', history: false },
  nedbank: { name: 'Nedbank', rate: 'cheque & transfer buying rate', history: false },
};
const SB_URL = 'https://ws15.standardbank.co.za/finSnapShot/GetforexServlet';
const ABSA_URL = 'https://www.absa.co.za/indices/exchange-rates/';
const NED_URL = 'https://onlineforms.nedsecure.co.za/forex/nedbank/forex-servicing/rates';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Invaro';

module.exports = function makeFx(cacheFile) {
  let cache = read();
  let sbIndex = null, sbIndexAt = 0; // Standard Bank's list of closing-rate days
  const current = {};                // bank -> { at, day, rates }: today's rates, re-read every 15 minutes

  function read() { try { return { days: {}, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) }; } catch (e) { return { days: {} }; } }
  function write() { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) {} }
  const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const keep = (bank, day, rates) => { cache.days[`${bank}:${day}`] = { rates }; write(); };

  async function get(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`the rates page answered ${res.status}`);
    return res;
  }

  // ---------- Standard Bank ----------
  async function sbPage(fn) {
    const opts = fn ? { method: 'POST', body: 'fn=' + encodeURIComponent(fn), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {};
    return Buffer.from(await (await get(SB_URL, opts)).arrayBuffer()).toString('latin1');
  }
  // { rates: { GBP: 22.5147, ... } in rand per unit, days: ['2026-11-20', ...] newest first }
  function sbParse(html) {
    const days = [...html.matchAll(/value="forex(\d{4})(\d{2})(\d{2})_16"/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<select[\s\S]*?<\/select>/gi, '')
      .replace(/<\/tr>/gi, '\n').replace(/<\/t[dh]>/gi, '|').replace(/<[^>]+>/g, '').replace(/&nbsp;?/g, ' ');
    const rates = {};
    let perRand = false; // the second block is quoted as foreign currency per R1
    for (const line of text.split('\n')) {
      if (/FOREIGN CURRENCY PER R1/i.test(line)) perRand = true;
      const cells = line.split('|').map(s => s.trim());
      if (cells.length < 3 || !/^[A-Z]{3}$/.test(cells[1])) continue;
      const v = parseFloat(cells[2]);
      if (v > 0) rates[cells[1]] = perRand ? 1 / v : v;
    }
    if (!Object.keys(rates).length) throw new Error("couldn't read Standard Bank's rates page (it may have changed)");
    return { rates, days };
  }
  async function sbToday() {
    const c = current.standard;
    if (c && Date.now() - c.at < 15 * 60 * 1000) return c;
    const p = sbParse(await sbPage());
    sbIndex = p.days; sbIndexAt = Date.now();
    return (current.standard = { at: Date.now(), day: localDay(new Date()), rates: p.rates });
  }
  async function sbDays() {
    if (!sbIndex || Date.now() - sbIndexAt > 3 * 3600 * 1000) await sbToday().catch(e => { if (!sbIndex) throw e; });
    if (!current.standard || Date.now() - current.standard.at > 15 * 60 * 1000) { current.standard = null; await sbToday(); }
    return sbIndex;
  }
  async function sbClosing(date) {
    const days = await sbDays();
    const day = days.find(d => d <= date);
    if (!day) throw new Error(`Standard Bank has no rates from before ${days[days.length - 1] || 'today'}`);
    if (!cache.days[`standard:${day}`]) keep('standard', day, sbParse(await sbPage(`forex${day.replace(/-/g, '')}_16`)).rates);
    return { day, rates: cache.days[`standard:${day}`].rates };
  }

  // ---------- Absa ----------
  async function absaToday() {
    const c = current.absa;
    if (c && Date.now() - c.at < 15 * 60 * 1000) return c;
    const html = await (await get(ABSA_URL)).text();
    const m = html.match(/class="forex_exchangeRates"[^>]*>([\s\S]*?)<\/div>/);
    if (!m) throw new Error("couldn't find the rates on Absa's page (it may have changed)");
    const json = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
    const rates = {};
    for (const row of json.currencyRates || []) {
      const r = row[row.CurrencyCode] || {}, v = parseFloat(r.BuyTransfers);
      if (/^[A-Z]{3}$/.test(row.CurrencyCode) && v > 0) rates[row.CurrencyCode] = r.MultiplyorDivide === '/' ? 1 / v : v;
    }
    if (!Object.keys(rates).length) throw new Error("couldn't read Absa's rates (the page may have changed)");
    const d = html.match(/Last updated:\s*(\d{4})\/(\d{2})\/(\d{2})/);
    const day = d ? `${d[1]}-${d[2]}-${d[3]}` : localDay(new Date());
    keep('absa', day, rates);
    return (current.absa = { at: Date.now(), day, rates });
  }

  // ---------- Nedbank ----------
  async function nedToday() {
    const c = current.nedbank;
    if (c && Date.now() - c.at < 15 * 60 * 1000) return c;
    const json = await (await get(NED_URL, { headers: { Accept: 'application/json' } })).json();
    const rates = {};
    for (const r of json.rateInfo || []) {
      const v = parseFloat(r.travelCheque && r.travelCheque.buyRate);
      if (r.baseCurrency === 'ZAR' && /^[A-Z]{3}$/.test(r.targetCurrency) && v > 0) rates[r.targetCurrency] = r.indicator === 'D' ? 1 / v : v;
    }
    if (!Object.keys(rates).length) throw new Error("couldn't read Nedbank's rates (the feed may have changed)");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(json.changedDate || '') ? json.changedDate : localDay(new Date());
    keep('nedbank', day, rates);
    return (current.nedbank = { at: Date.now(), day, rates });
  }

  const todayOf = { standard: sbToday, absa: absaToday, nedbank: nedToday };

  // The rand value of one unit of `currency` on `date` (YYYY-MM-DD) at `bank`'s buying rate:
  // today's rate for today (or a later date). For an earlier date: Standard Bank's 16:00 closing rate
  // (or the last business day's before it); for Absa and Nedbank, the latest day Invaro kept within the
  // week before. Returns { bank, rate, on, kind: 'current' | 'closing' | 'kept', source }, or throws
  // with err.noHistory when the bank has nothing for that date.
  async function rate(bank, currency, date) {
    bank = BANKS[bank] ? bank : 'standard';
    currency = String(currency || '').toUpperCase();
    const source = `${BANKS[bank].name}'s ${BANKS[bank].rate}`;
    const today = localDay(new Date());
    if (!date || date >= today) {
      const t = await todayOf[bank]();
      const r = t.rates[currency];
      if (!r) throw new Error(`${BANKS[bank].name} doesn't quote ${currency}`);
      return { bank, rate: r, on: t.day, kind: 'current', source };
    }
    if (bank === 'standard') {
      const { day, rates } = await sbClosing(date);
      if (!rates[currency]) throw new Error(`Standard Bank didn't quote ${currency} on ${day}`);
      return { bank, rate: rates[currency], on: day, kind: 'closing', source };
    }
    const weekBefore = localDay(new Date(new Date(date + 'T12:00:00').getTime() - 7 * 86400000));
    const kept = Object.keys(cache.days).filter(k => k.startsWith(bank + ':')).map(k => k.slice(bank.length + 1))
      .filter(d => d <= date && d >= weekBefore && cache.days[`${bank}:${d}`].rates[currency]).sort().pop();
    if (kept) return { bank, rate: cache.days[`${bank}:${kept}`].rates[currency], on: kept, kind: 'kept', source };
    const err = new Error(`${BANKS[bank].name} only publishes today's rates, and Invaro hadn't kept one for ${date}`);
    err.noHistory = true;
    throw err;
  }

  // Every bank's rate for that date at once (for recording on an invoice when it's saved).
  // Returns { standard: {...} | { error }, absa: ..., nedbank: ... }.
  async function rates(currency, date) {
    const out = {};
    await Promise.all(Object.keys(BANKS).map(async b => {
      try { out[b] = await rate(b, currency, date); } catch (e) { out[b] = { error: e.message, noHistory: !!e.noHistory }; }
    }));
    return out;
  }

  return { rate, rates, banks: BANKS };
};
module.exports.BANKS = BANKS;
