// Loads the app's own scripts (app/*.js) into Node, so the tests call the real code, unchanged.
//
// The app's scripts are plain browser scripts that share globals (no modules), and wire up the page as
// they load ($('#x').onclick = …). Here they run in a fresh vm context with a stand-in page: every
// element is a "do-nothing" object that accepts any property, call or loop. The page reports it's still
// loading, so the app's start-up (init in renderer.js) waits forever and never runs: each test sets up
// exactly the data it needs instead.
//
//   const app = loadApp();
//   app.set({ clients: [...], invoices: [...], settings: {...} });
//   app.lineAmount({ kind: 'hours', qty: 2 }, { hourlyRate: 50 });   // any function or const in the app
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'app');
const JSPDF = require.resolve('jspdf/dist/jspdf.umd.min.js');
// In the order index.html loads them (tips.js only draws the ⓘ tips, so it's left out).
// Read from index.html, so a script added there is tested too, in the same order.
const SCRIPTS = [...fs.readFileSync(path.join(APP, 'index.html'), 'utf8').matchAll(/<script src="([\w-]+\.js)">/g)]
  .map(m => m[1]).filter(f => f !== 'tips.js');

// An element (or anything else on the page) that does nothing: any property is another one of these,
// calling it returns another, setting a property is fine, and looping over it finds nothing.
function nothing() {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined; // not a promise
      if (k === 'length') return 0;
      if (k === 'hidden' || k === 'checked' || k === 'disabled') return false;
      if (k === 'value' || k === 'textContent' || k === 'innerHTML') return '';
      if (k === 'contains') return () => false; // classList.contains
      return nothing();
    },
    set: () => true,
    apply: () => nothing(),
    construct: () => nothing(),
  });
}

function loadApp({ today } = {}) {
  const document = new Proxy({
    readyState: 'loading', // keeps init() waiting, see above
    addEventListener() {},
    querySelector: () => nothing(),
    querySelectorAll: () => [],
    createElement: () => nothing(),
    getElementById: () => nothing(),
  }, { get: (t, k) => (k in t ? t[k] : nothing()) });

  const memory = {};
  const sandbox = {
    // The app's timers (debounced saves, checks every few minutes) mustn't keep the test run open.
    setTimeout: (f, ms, ...a) => setTimeout(f, ms, ...a).unref(), clearTimeout,
    setInterval: (f, ms, ...a) => setInterval(f, ms, ...a).unref(), clearInterval,
    console, URL, TextDecoder, TextEncoder,
    Intl, structuredClone, queueMicrotask,
    document,
    localStorage: { getItem: k => memory[k] ?? null, setItem: (k, v) => { memory[k] = String(v); }, removeItem: k => { delete memory[k]; } },
    navigator: { platform: 'test', userAgent: 'node' },
    location: { reload() {}, hash: '' },
    confirm: () => true, alert() {}, prompt: () => null,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: f => setTimeout(f, 0),
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    Image: class {}, FileReader: class {},
    Blob, atob, btoa, // jsPDF makes the preview's PDF as a Blob (URL.createObjectURL)
    fetch: async () => { throw new Error('No network in tests'); },
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 800,
  };
  sandbox.window = sandbox; // window.api is undefined, so the app uses its plain-browser store
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  if (today) {
    // A fixed "today", so overdue and month-by-month figures don't depend on when the tests run.
    vm.runInContext(`(() => { const Real = Date, fixed = new Real(${JSON.stringify(today + 'T12:00:00')}).getTime();
      class D extends Real { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } }
      globalThis.Date = D; })();`, ctx);
  }
  // The real jsPDF, as index.html loads it: the preview and Save build real PDFs (the preview refreshes
  // on a timer after most changes, so without it those timers fail after a test has finished).
  vm.runInContext(fs.readFileSync(JSPDF, 'utf8'), ctx, { filename: 'jspdf.umd.min.js' });
  for (const f of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(APP, f), 'utf8'), ctx, { filename: f });

  const run = code => vm.runInContext(code, ctx);
  // The app's data lives in `let` globals (clients, settings, invoices, stock, stockMoves, draft…),
  // which only code inside the context can assign, so set() hands each value over and assigns it.
  const set = values => {
    for (const [k, v] of Object.entries(values)) { sandbox.__value = v; run(`${k} = __value`); }
    delete sandbox.__value;
  };
  // app.someName reads any top-level function, const or let from the app's scripts.
  return new Proxy({ run, set, context: ctx }, {
    get: (t, k) => (k in t || typeof k === 'symbol' ? t[k] : run(k)),
  });
}

// Objects made inside the app's context have that context's Object and Array, which
// assert.deepStrictEqual treats as different from the test's own: compare plain copies instead.
const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

module.exports = { loadApp, plain };
