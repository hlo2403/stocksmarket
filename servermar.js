'use strict';
// Marketboard server: serves the dashboard and a small JSON API for live prices.
// Requires Node.js 18 or newer. There are no packages to install.
//
//   node server.js          then open http://localhost:3000
//
// Environment variables: PORT (default 3000), HOST (default 127.0.0.1, or 0.0.0.0 when PORT is set),
// PROVIDER_BASE (default Yahoo Finance's public chart endpoint), QUOTE_TTL_MS (how long a quote is cached, default 10000).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
// Hosting services set PORT, and then the server must listen on all addresses. On your own computer it stays private.
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PROVIDER = process.env.PROVIDER_BASE || 'https://query1.finance.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; Marketboard/1.0)', Accept: 'application/json' };
const RANGES = new Set(['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y']);
const SYMBOL = /^[A-Za-z0-9.^=&\-]{1,20}$/;
const TTL = { history: 5 * 60e3, quote: Number(process.env.QUOTE_TTL_MS) || 10e3 };

// Small in-memory cache so many visitors and 30-second refreshes do not flood the data provider.
const cache = new Map();
function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = load().catch(err => { cache.delete(key); throw err; });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

// The only function that talks to the provider. To switch providers, change this one function
// so that it returns { symbol, name, currency, price, t, o, h, l, c, v } with daily bars.
async function fetchChart(symbol, range) {
  const url = `${PROVIDER}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Data provider returned ${res.status} for ${symbol}`);
  const body = await res.json();
  const r = body.chart && body.chart.result && body.chart.result[0];
  if (!r || !r.timestamp) throw new Error(`No data for ${symbol}`);
  const q = r.indicators.quote[0];
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  r.timestamp.forEach((t, i) => {
    if (q.close[i] == null) return;            // skip holidays and gaps
    out.t.push(t);
    out.o.push(q.open[i] != null ? q.open[i] : q.close[i]);
    out.h.push(q.high[i] != null ? q.high[i] : q.close[i]);
    out.l.push(q.low[i] != null ? q.low[i] : q.close[i]);
    out.c.push(q.close[i]);
    out.v.push(q.volume[i] || 0);
  });
  const meta = r.meta || {};
  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || 'USD',
    price: meta.regularMarketPrice != null ? meta.regularMarketPrice : out.c[out.c.length - 1],
    ...out
  };
}

async function quote(symbol) {
  const d = await cached(`q:${symbol}:5d`, TTL.quote, () => fetchChart(symbol, '5d'));
  const n = d.c.length;
  return { symbol: d.symbol, price: d.price, prevClose: n > 1 ? d.c[n - 2] : d.price, time: d.t[n - 1] };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (e) { out[i] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store'
  });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    return res.end();
  }
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, provider: PROVIDER });

    if (url.pathname === '/api/history') {
      const symbol = (url.searchParams.get('symbol') || '').trim();
      const range = url.searchParams.get('range') || '1y';
      if (!SYMBOL.test(symbol)) return json(res, 400, { error: 'Invalid symbol' });
      if (!RANGES.has(range)) return json(res, 400, { error: 'Invalid range' });
      return json(res, 200, await cached(`h:${symbol}:${range}`, TTL.history, () => fetchChart(symbol, range)));
    }

    if (url.pathname === '/api/quotes') {
      const symbols = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
      if (!symbols.length || !symbols.every(s => SYMBOL.test(s))) return json(res, 400, { error: 'Invalid symbols' });
      const rows = await mapLimit(symbols, 6, quote);
      return json(res, 200, { quotes: rows.filter(Boolean), failed: symbols.filter((s, i) => !rows[i]) });
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown endpoint' });

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
    }
    return send(res, 404, 'Not found', 'text/plain');
  } catch (err) {
    return json(res, 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => console.log(`Marketboard running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
