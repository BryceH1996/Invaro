// Standard Bank's exchange rates, for showing invoices in rand in Reports.
//
// Reads the bank's public rates page (the same one its website shows): today's opening indication
// rates, and each business day's 16:00 closing rates back to 2002 (posting fn=forex<yyyymmdd>_16).
// The rate used is "Bank Buying T/T": the rand Standard Bank pays for each unit of foreign currency
// that's paid to you. Only the date is sent. Each day's rates are kept in fx-cache.json, so a day is
// fetched once.
const fs = require('fs');

const URL = 'https://ws15.standardbank.co.za/finSnapShot/GetforexServlet';
const SOURCE = "Standard Bank's T/T buying rate";

module.exports = function makeFx(cacheFile) {
  let cache = read();
  let index = null, indexAt = 0; // the list of closing-rate days, and when it was read

  function read() { try { return { days: {}, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) }; } catch (e) { return { days: {} }; } }
  function write() { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch (e) {} }

  async function page(fn) {
    const opts = { headers: { 'User-Agent': 'Invaro' }, signal: AbortSignal.timeout(20000) };
    if (fn) Object.assign(opts, { method: 'POST', body: 'fn=' + encodeURIComponent(fn),
      headers: { ...opts.headers, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const res = await fetch(URL, opts);
    if (!res.ok) throw new Error(`Standard Bank's rates page answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString('latin1');
  }

  // { rates: { GBP: 22.5147, ... } in rand per unit, title, days: ['2026-11-20', ...] newest first }
  function parse(html) {
    const days = [...html.matchAll(/value="forex(\d{4})(\d{2})(\d{2})_16"/g)].map(m => `${m[1]}-${m[2]}-${m[3]}`);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<select[\s\S]*?<\/select>/gi, '')
      .replace(/<\/tr>/gi, '\n').replace(/<\/t[dh]>/gi, '|').replace(/<[^>]+>/g, '').replace(/&nbsp;?/g, ' ');
    const rates = {};
    let perRand = false; // the second block is quoted as foreign currency per R1
    let title = '';
    for (const line of text.split('\n')) {
      if (/FOREX .*RATES FOR/i.test(line)) title = line.replace(/\|/g, '').replace(/\s+/g, ' ').trim();
      if (/FOREIGN CURRENCY PER R1/i.test(line)) perRand = true;
      const cells = line.split('|').map(s => s.trim());
      if (cells.length < 3 || !/^[A-Z]{3}$/.test(cells[1])) continue;
      const v = parseFloat(cells[2]);
      if (!(v > 0)) continue;
      rates[cells[1]] = perRand ? 1 / v : v;
    }
    if (!Object.keys(rates).length) throw new Error("Couldn't read Standard Bank's rates page (it may have changed)");
    return { rates, title, days };
  }

  // The closing-rate days the bank has, refreshed every few hours (it adds one each weekday at 16:00).
  async function closingDays() {
    if (index && Date.now() - indexAt < 3 * 3600 * 1000) return index;
    const p = parse(await page());
    index = p.days; indexAt = Date.now();
    const today = localDay(new Date());
    cache.days[`open:${today}`] = { rates: p.rates, title: p.title };
    write();
    return index;
  }

  const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // The rand value of one unit of `currency` on `date` (YYYY-MM-DD): today's indication rate for today
  // (or a later date), otherwise that day's 16:00 closing rate, or the last business day's before it.
  // Returns { rate, on, kind: 'opening' | 'closing', source } or throws.
  async function rate(currency, date) {
    currency = String(currency || '').toUpperCase();
    if (currency === 'ZAR') return { rate: 1, on: date, kind: 'same', source: 'Rand' };
    const today = localDay(new Date());
    if (!date || date >= today) {
      await closingDays(); // also reads today's opening rates
      const sheet = cache.days[`open:${today}`];
      const r = sheet && sheet.rates[currency];
      if (!r) throw new Error(`Standard Bank doesn't quote ${currency}`);
      return { rate: r, on: today, kind: 'opening', source: SOURCE };
    }
    const days = await closingDays();
    const day = days.find(d => d <= date);
    if (!day) throw new Error(`Standard Bank has no rates from before ${days[days.length - 1] || 'today'}`);
    if (!cache.days[day]) {
      const p = parse(await page(`forex${day.replace(/-/g, '')}_16`));
      cache.days[day] = { rates: p.rates, title: p.title };
      write();
    }
    const r = cache.days[day].rates[currency];
    if (!r) throw new Error(`Standard Bank didn't quote ${currency} on ${day}`);
    return { rate: r, on: day, kind: 'closing', source: SOURCE };
  }

  return { rate };
};
