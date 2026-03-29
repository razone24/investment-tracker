const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const crypto = require('crypto');

/*
 * Investment tracker backend without external dependencies.
 *
 * Changes in this revision:
 * - Queryable/paginated investments endpoint with backward-compatible array mode.
 * - Investment edit API, bulk delete API, import validation API.
 * - Portfolio summary API with by-fund and by-platform aggregates.
 * - Async, debounced, atomic JSON persistence to avoid blocking sync writes.
 * - Static asset caching headers (ETag/Cache-Control) + optional gzip.
 * - Safer/stronger id generation than Date.now() collisions.
 * - Rates fetch hardening with fallback provider + TTL policy.
 */

const dataFile = path.join(__dirname, 'data.json');
const publicDir = path.join(__dirname, 'public');

let investments = [];
let objective = null;
let rates = { date: null, rates: { RON: 1 }, provider: 'bootstrap' };
let netWorth = { manualItems: [] };
let milestones = [];
let milestonesCurrency = 'RON';
let profitTracker = {
  entries: [],
  settings: { minSalary: 4050, cassRate: 0.1, thresholds: [6, 12, 24], currency: 'RON' },
};

let prediction = null;
let predicting = false;
let predictionId = null;

const defaultNetWorthItems = () => ([
  { id: 'nw-realestate', name: 'RealEstate', type: 'asset', value: 0, currency: 'RON' },
  { id: 'nw-retirement', name: 'Retirement', type: 'asset', value: 0, currency: 'RON' },
  { id: 'nw-bonds', name: 'Bonds', type: 'asset', value: 0, currency: 'RON' },
  { id: 'nw-stocks', name: 'Stocks', type: 'asset', value: 0, currency: 'RON' },
  { id: 'nw-crypto', name: 'Crypto', type: 'asset', value: 0, currency: 'RON' },
  { id: 'nw-cash', name: 'Cash/HYSA', type: 'asset', value: 0, currency: 'RON' },
  { id: 'nw-cc-debt', name: 'CC Debt', type: 'liability', value: 0, currency: 'RON' },
  { id: 'nw-mortgage', name: 'Mortgage', type: 'liability', value: 0, currency: 'RON' },
]);

const defaultProfitSettings = () => ({ minSalary: 4050, cassRate: 0.1, thresholds: [6, 12, 24], currency: 'RON' });

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_BODY_SIZE_BYTES = 10 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 150;
const RATES_TTL_MS = 6 * 60 * 60 * 1000;

let persistTimer = null;
let persistPending = false;
let persistInFlight = false;
let lastRatesFetchAt = 0;
let idCounter = 0;
let server = null;
let ratesInterval = null;

const staticCache = new Map();

function sanitizeString(value, fallback = '') {
  if (typeof value === 'string') {
    const v = value.trim();
    return v || fallback;
  }
  return fallback;
}

function parseNumberMaybe(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toPositiveInt(value, fallback, max = 1000) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

function normalizeDateInput(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

function sortInvestmentsByTimestampDesc(list) {
  list.sort((a, b) => {
    const at = typeof a.timestamp === 'number' ? a.timestamp : 0;
    const bt = typeof b.timestamp === 'number' ? b.timestamp : 0;
    return bt - at;
  });
}

function generateId(prefix = 'inv') {
  idCounter = (idCounter + 1) % 1000000;
  const nowPart = Date.now().toString(36);
  const hrPart = process.hrtime.bigint().toString(36).slice(-7);
  const randPart = crypto.randomBytes(2).toString('hex');
  const countPart = idCounter.toString(36);
  return `${prefix}-${nowPart}-${hrPart}-${randPart}-${countPart}`;
}

function normalizeInvestmentPayload(input, existing = null) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Invalid payload' };
  }

  const merged = {
    ...existing,
    ...input,
  };

  const currency = sanitizeString(merged.currency, '').toUpperCase();
  const fund = sanitizeString(merged.fund, 'Unknown');
  const platform = sanitizeString(merged.platform, 'Unknown');
  const date = normalizeDateInput(merged.date);

  const unitPrice = parseNumberMaybe(merged.unitPrice);
  const units = parseNumberMaybe(merged.units);
  const amountFromPayload = parseNumberMaybe(merged.amount);

  let amount = null;
  if (unitPrice != null && units != null && unitPrice >= 0) {
    amount = unitPrice * units;
  } else if (amountFromPayload != null) {
    amount = amountFromPayload;
  } else if (existing && typeof existing.amount === 'number') {
    amount = existing.amount;
  }

  if (!currency || !fund || !platform || !date) {
    return { ok: false, error: 'currency, fund, platform and date are required' };
  }
  if (amount == null || !Number.isFinite(amount)) {
    return { ok: false, error: 'amount or unitPrice+units are required' };
  }

  const normalized = {
    currency,
    fund,
    platform,
    date,
    amount,
  };

  if (unitPrice != null && Number.isFinite(unitPrice)) {
    normalized.unitPrice = unitPrice;
  }
  if (units != null && Number.isFinite(units)) {
    normalized.units = units;
    if (units < 0) normalized.isSale = true;
  }

  return { ok: true, investment: normalized };
}

function validateImportRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const validRows = [];
  const invalidRows = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const parsed = normalizeInvestmentPayload(row, null);
    if (parsed.ok) {
      validRows.push(parsed.investment);
    } else {
      const failure = {
        index: idx,
        error: parsed.error || 'Invalid row',
        row,
      };
      invalidRows.push(failure);
      errors.push({ index: idx, message: failure.error });
    }
  });

  return { validRows, invalidRows, errors };
}

function convertAmount(amount, from, to) {
  if (!rates.rates[from] || !rates.rates[to]) return null;
  const inRon = amount * rates.rates[from];
  return inRon / rates.rates[to];
}

function pickLatestInvestment(list) {
  let latest = null;
  for (const inv of list) {
    if (!latest) {
      latest = inv;
      continue;
    }
    if (inv.date > latest.date) {
      latest = inv;
      continue;
    }
    if (inv.date === latest.date) {
      const curTs = typeof inv.timestamp === 'number' ? inv.timestamp : 0;
      const bestTs = typeof latest.timestamp === 'number' ? latest.timestamp : 0;
      if (curTs > bestTs) {
        latest = inv;
      }
    }
  }
  return latest;
}

function getFundGroups(sourceInvestments) {
  const byFund = {};
  for (const inv of sourceInvestments) {
    if (!byFund[inv.fund]) byFund[inv.fund] = [];
    byFund[inv.fund].push(inv);
  }
  return byFund;
}

function computeLatestPriceForFund(invs) {
  const latestInv = pickLatestInvestment(invs);
  if (!latestInv) return null;
  if (typeof latestInv.unitPrice === 'number') {
    return { price: latestInv.unitPrice, currency: latestInv.currency };
  }
  if (typeof latestInv.units === 'number' && latestInv.units !== 0) {
    return { price: latestInv.amount / latestInv.units, currency: latestInv.currency };
  }
  return null;
}

function computePortfolioSummary(targetCurrency) {
  const desiredCurrency = sanitizeString(targetCurrency, 'RON').toUpperCase();
  const byFund = getFundGroups(investments);

  const fundRows = [];
  const platformMap = {};

  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalRealized = 0;

  const latestByFund = {};
  Object.keys(byFund).forEach((fund) => {
    latestByFund[fund] = computeLatestPriceForFund(byFund[fund]);
  });

  Object.keys(byFund).forEach((fund) => {
    const invs = byFund[fund];
    const latest = latestByFund[fund];

    let totalUnits = 0;
    let investedAmount = 0;
    let buyUnits = 0;
    let buyAmount = 0;
    let soldUnits = 0;
    let saleProceeds = 0;

    invs.forEach((inv) => {
      const invUnits = typeof inv.units === 'number'
        ? inv.units
        : (typeof inv.unitPrice === 'number' && inv.unitPrice !== 0 ? inv.amount / inv.unitPrice : 0);

      let normalizedUnits = invUnits;
      if ((!Number.isFinite(normalizedUnits) || normalizedUnits === 0) && latest) {
        const conv = convertAmount(inv.amount, inv.currency, latest.currency);
        if (conv != null && latest.price !== 0) {
          normalizedUnits = conv / latest.price;
        }
      }
      if (!Number.isFinite(normalizedUnits)) normalizedUnits = 0;

      totalUnits += normalizedUnits;

      const isSale = normalizedUnits < 0 || inv.amount < 0;
      if (isSale) {
        soldUnits += Math.abs(normalizedUnits);
        const proceeds = convertAmount(Math.abs(inv.amount), inv.currency, desiredCurrency);
        if (proceeds != null) saleProceeds += proceeds;
      } else {
        const invested = convertAmount(inv.amount, inv.currency, desiredCurrency);
        if (invested != null) {
          investedAmount += invested;
          buyAmount += invested;
        }
        buyUnits += Math.max(0, normalizedUnits);
      }

      if (!platformMap[inv.platform]) {
        platformMap[inv.platform] = {
          platform: inv.platform,
          transactions: 0,
          invested: 0,
          currentValue: 0,
          units: 0,
          realizedDelta: 0,
          unrealizedDelta: 0,
          pnlTotal: 0,
          funds: new Set(),
        };
      }

      const platformRow = platformMap[inv.platform];
      platformRow.transactions += 1;
      platformRow.units += normalizedUnits;
      platformRow.funds.add(inv.fund);
      if (isSale) {
        const proceeds = convertAmount(Math.abs(inv.amount), inv.currency, desiredCurrency);
        if (proceeds != null) {
          platformRow.realizedDelta += proceeds;
          platformRow.pnlTotal += proceeds;
        }
      } else {
        const invested = convertAmount(inv.amount, inv.currency, desiredCurrency);
        if (invested != null) {
          platformRow.invested += invested;
        }
      }
    });

    let currentValue = 0;
    if (latest) {
      const valueInLatest = totalUnits * latest.price;
      const converted = convertAmount(valueInLatest, latest.currency, desiredCurrency);
      currentValue = converted != null ? converted : 0;
    } else {
      invs.forEach((inv) => {
        const converted = convertAmount(inv.amount, inv.currency, desiredCurrency);
        if (converted != null) currentValue += converted;
      });
    }

    const avgBuyCost = buyUnits > 0 ? buyAmount / buyUnits : 0;
    const soldCostEstimate = soldUnits * avgBuyCost;
    const realizedDelta = saleProceeds - soldCostEstimate;
    const currentCostBasis = Math.max(0, totalUnits) * avgBuyCost;
    const unrealizedDelta = currentValue - currentCostBasis;
    const pnlTotal = realizedDelta + unrealizedDelta;

    fundRows.push({
      fund,
      transactions: invs.length,
      units: totalUnits,
      invested: investedAmount,
      currentValue,
      latestUnitPrice: latest ? convertAmount(latest.price, latest.currency, desiredCurrency) : null,
      latestPriceCurrency: desiredCurrency,
      avgBuyCost,
      realizedDelta,
      unrealizedDelta,
      pnlTotal,
    });

    totalInvested += investedAmount;
    totalCurrentValue += currentValue;
    totalRealized += realizedDelta;
  });

  const platformRows = Object.values(platformMap).map((row) => {
    const fundList = Array.from(row.funds);
    let currentValue = 0;

    fundList.forEach((fund) => {
      const latest = latestByFund[fund];
      if (!latest) return;
      const invs = investments.filter((inv) => inv.platform === row.platform && inv.fund === fund);
      let units = 0;
      invs.forEach((inv) => {
        if (typeof inv.units === 'number') {
          units += inv.units;
        } else if (typeof inv.unitPrice === 'number' && inv.unitPrice !== 0) {
          units += inv.amount / inv.unitPrice;
        } else {
          const conv = convertAmount(inv.amount, inv.currency, latest.currency);
          if (conv != null && latest.price !== 0) units += conv / latest.price;
        }
      });
      const valueInLatest = units * latest.price;
      const converted = convertAmount(valueInLatest, latest.currency, desiredCurrency);
      if (converted != null) currentValue += converted;
    });

    const unrealized = currentValue - row.invested;
    return {
      platform: row.platform,
      transactions: row.transactions,
      funds: fundList.length,
      units: row.units,
      invested: row.invested,
      currentValue,
      realizedDelta: row.realizedDelta,
      unrealizedDelta: unrealized,
      pnlTotal: row.realizedDelta + unrealized,
    };
  });

  fundRows.sort((a, b) => b.currentValue - a.currentValue);
  platformRows.sort((a, b) => b.currentValue - a.currentValue);

  return {
    currency: desiredCurrency,
    totals: {
      invested: totalInvested,
      currentValue: totalCurrentValue,
      realizedDelta: totalRealized,
      unrealizedDelta: totalCurrentValue - totalInvested,
      pnlTotal: (totalCurrentValue - totalInvested) + totalRealized,
    },
    byFund: fundRows,
    byPlatform: platformRows,
    ratesDate: rates.date,
  };
}

function buildQueryResult(source, query) {
  const hasQueryParams = query && Object.keys(query).length > 0;
  const legacy =
    !hasQueryParams ||
    query.legacy === '1' ||
    query.legacy === 'true' ||
    query.shape === 'array';

  const normalized = [...source];
  sortInvestmentsByTimestampDesc(normalized);

  if (legacy) {
    return { legacy: true, data: normalized };
  }

  const search = sanitizeString(query.search, '').toLowerCase();
  const fund = sanitizeString(query.fund, '');
  const platform = sanitizeString(query.platform, '');
  const dateFrom = normalizeDateInput(query.dateFrom);
  const dateTo = normalizeDateInput(query.dateTo);

  let filtered = normalized;

  if (fund && fund !== 'All') {
    filtered = filtered.filter((inv) => inv.fund === fund);
  }
  if (platform && platform !== 'All') {
    filtered = filtered.filter((inv) => inv.platform === platform);
  }
  if (dateFrom) {
    filtered = filtered.filter((inv) => inv.date >= dateFrom);
  }
  if (dateTo) {
    filtered = filtered.filter((inv) => inv.date <= dateTo);
  }
  if (search) {
    filtered = filtered.filter((inv) => {
      const haystack = `${inv.fund} ${inv.platform} ${inv.currency} ${inv.date}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  const sortBy = sanitizeString(query.sortBy, 'timestamp');
  const sortDir = sanitizeString(query.sortDir, 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const sortableField = ['timestamp', 'date', 'fund', 'platform', 'amount', 'currency', 'units', 'unitPrice'].includes(sortBy)
    ? sortBy
    : 'timestamp';

  filtered.sort((a, b) => {
    const av = a[sortableField];
    const bv = b[sortableField];

    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') {
      cmp = av - bv;
    } else {
      const as = av == null ? '' : String(av);
      const bs = bv == null ? '' : String(bv);
      cmp = as.localeCompare(bs);
    }

    return sortDir === 'asc' ? cmp : -cmp;
  });

  const page = toPositiveInt(query.page, 1, 1_000_000);
  const pageSize = toPositiveInt(query.pageSize, 25, 500);
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  return {
    legacy: false,
    data: {
      items,
      total,
      page,
      pageSize,
      sortBy: sortableField,
      sortDir,
      filters: {
        search,
        fund: fund || 'All',
        platform: platform || 'All',
        dateFrom: dateFrom || '',
        dateTo: dateTo || '',
      },
    },
  };
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res, statusCode = 204) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
  });
  res.end();
}

function parseRequestBody(req, res, cb) {
  let body = '';
  let tooLarge = false;

  req.on('data', (chunk) => {
    if (tooLarge) return;
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_SIZE_BYTES) {
      tooLarge = true;
      sendJson(res, 413, { error: 'Payload too large' });
      req.destroy();
    }
  });

  req.on('end', () => {
    if (tooLarge) return;
    if (!body) {
      cb(null, null);
      return;
    }
    try {
      const payload = JSON.parse(body);
      cb(null, payload);
    } catch (err) {
      cb(new Error('Invalid JSON'));
    }
  });

  req.on('error', (err) => cb(err));
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.mjs': return 'application/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.ico': return 'image/x-icon';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

function isCompressibleContent(contentType) {
  return (
    contentType.startsWith('text/') ||
    contentType.includes('javascript') ||
    contentType.includes('json') ||
    contentType.includes('svg+xml')
  );
}

async function readStaticAsset(fullPath) {
  const stat = await fsp.stat(fullPath);
  const cached = staticCache.get(fullPath);

  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }

  const data = await fsp.readFile(fullPath);
  const contentType = getContentType(fullPath);
  const etag = `W/\"${stat.size}-${Math.floor(stat.mtimeMs)}\"`;

  const asset = {
    data,
    gzipData: isCompressibleContent(contentType) ? zlib.gzipSync(data, { level: 6 }) : null,
    contentType,
    etag,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };

  staticCache.set(fullPath, asset);
  return asset;
}

async function serveStatic(reqPath, req, res) {
  let normalizedPath = reqPath || '/';
  if (normalizedPath === '/') {
    normalizedPath = '/index.html';
  }

  // Block traversal attempts.
  const decodedPath = decodeURIComponent(normalizedPath);
  const withoutLeadingSlashes = decodedPath.replace(/^[/\\]+/, '');
  const safePath = path.normalize(withoutLeadingSlashes).replace(/^([.][.][/\\])+/, '');
  const fullPath = path.join(publicDir, safePath);

  let pathToUse = fullPath;
  if (!fullPath.startsWith(publicDir)) {
    pathToUse = path.join(publicDir, 'index.html');
  }

  try {
    const asset = await readStaticAsset(pathToUse);
    const isHtml = path.extname(pathToUse).toLowerCase() === '.html';
    const reqEtag = req.headers['if-none-match'];
    if (reqEtag && reqEtag === asset.etag) {
      res.writeHead(304, {
        ETag: asset.etag,
      });
      res.end();
      return;
    }

    const acceptsGzip = typeof req.headers['accept-encoding'] === 'string' && req.headers['accept-encoding'].includes('gzip');
    const useGzip = acceptsGzip && !!asset.gzipData;

    const headers = {
      'Content-Type': asset.contentType,
      'ETag': asset.etag,
      'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Vary': 'Accept-Encoding',
    };

    if (useGzip) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = asset.gzipData.length;
      res.writeHead(200, headers);
      res.end(asset.gzipData);
      return;
    }

    headers['Content-Length'] = asset.data.length;
    res.writeHead(200, headers);
    res.end(asset.data);
  } catch (err) {
    try {
      const fallback = await readStaticAsset(path.join(publicDir, 'index.html'));
      res.writeHead(200, {
        'Content-Type': fallback.contentType,
        'Cache-Control': 'no-cache',
      });
      res.end(fallback.data);
    } catch (innerErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  }
}

function serializeState() {
  return JSON.stringify({ investments, objective, netWorth, milestones, milestonesCurrency, profitTracker }, null, 2);
}

async function writeStateAtomic() {
  const payload = serializeState();
  const tmpPath = `${dataFile}.tmp`;
  await fsp.writeFile(tmpPath, payload, 'utf8');
  await fsp.rename(tmpPath, dataFile);
}

async function flushDataPersistence() {
  if (persistInFlight) {
    return;
  }
  if (!persistPending) {
    return;
  }

  persistPending = false;
  persistInFlight = true;
  try {
    await writeStateAtomic();
  } catch (err) {
    console.error('Error writing data file:', err);
  } finally {
    persistInFlight = false;
    if (persistPending) {
      await flushDataPersistence();
    }
  }
}

function saveData() {
  persistPending = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushDataPersistence().catch((err) => {
      console.error('Persistence flush error:', err);
    });
  }, PERSIST_DEBOUNCE_MS);
}

async function forceFlushData() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistPending = true;
  await flushDataPersistence();
}

function loadData() {
  try {
    if (!fs.existsSync(dataFile)) {
      return;
    }
    const raw = fs.readFileSync(dataFile, 'utf8');
    const parsed = JSON.parse(raw);

    investments = Array.isArray(parsed.investments) ? parsed.investments : [];
    investments.forEach((inv, idx) => {
      if (typeof inv.timestamp !== 'number') {
        const parsedTs = parseInt(inv.id, 10);
        inv.timestamp = Number.isFinite(parsedTs) ? parsedTs : Date.now() - idx;
      }
      if (typeof inv.id !== 'string' || !inv.id) {
        inv.id = generateId();
      }
    });
    sortInvestmentsByTimestampDesc(investments);

    objective = parsed.objective || null;
    netWorth = parsed.netWorth || { manualItems: [] };
    if (!Array.isArray(netWorth.manualItems) || netWorth.manualItems.length === 0) {
      netWorth.manualItems = defaultNetWorthItems();
    }

    milestones = Array.isArray(parsed.milestones) ? parsed.milestones : [];
    milestonesCurrency = typeof parsed.milestonesCurrency === 'string' && parsed.milestonesCurrency
      ? parsed.milestonesCurrency.toUpperCase()
      : 'RON';

    profitTracker = parsed.profitTracker || { entries: [], settings: defaultProfitSettings() };
    if (!Array.isArray(profitTracker.entries)) {
      profitTracker.entries = [];
    }
    if (!profitTracker.settings || typeof profitTracker.settings !== 'object') {
      profitTracker.settings = defaultProfitSettings();
    }

    const defaults = defaultProfitSettings();
    if (typeof profitTracker.settings.minSalary !== 'number') profitTracker.settings.minSalary = defaults.minSalary;
    if (typeof profitTracker.settings.cassRate !== 'number') profitTracker.settings.cassRate = defaults.cassRate;
    if (!Array.isArray(profitTracker.settings.thresholds) || profitTracker.settings.thresholds.length === 0) {
      profitTracker.settings.thresholds = defaults.thresholds;
    }
    if (typeof profitTracker.settings.currency !== 'string' || !profitTracker.settings.currency) {
      profitTracker.settings.currency = defaults.currency;
    }
  } catch (err) {
    console.error('Error reading data file:', err);
  }
}

function parseRatesFromCursBnr(html) {
  const result = { date: new Date().toISOString().split('T')[0], rates: { RON: 1 }, provider: 'cursbnr' };
  const dateMatch = /<th colspan="2" class="text-center">([^<]+)<\/th>/.exec(html);
  if (dateMatch) {
    result.date = dateMatch[1].trim();
  }
  const regex = /<td class="text-center hidden-xs">([^<]+)<\/td>[\s\S]*?<td class="text-center">([0-9.]+)<\/td>/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    let code = m[1].trim();
    const val = parseFloat(m[2].trim());
    if (!Number.isFinite(val)) continue;

    let multiplier = 1;
    const multiMatch = code.match(/^(\d+)([A-Z]{3})$/);
    if (multiMatch) {
      multiplier = parseInt(multiMatch[1], 10);
      code = multiMatch[2];
    }

    result.rates[code] = val / multiplier;
  }
  return result;
}

function parseFallbackRatesJson(jsonStr) {
  const parsed = JSON.parse(jsonStr);
  if (!parsed || !parsed.rates || typeof parsed.rates !== 'object') {
    throw new Error('Fallback rates payload invalid');
  }

  // open.er-api.com/latest/RON uses RON as base.
  const mapped = { RON: 1 };
  Object.keys(parsed.rates).forEach((code) => {
    const value = parseFloat(parsed.rates[code]);
    if (Number.isFinite(value) && value > 0) {
      mapped[code.toUpperCase()] = 1 / value;
    }
  });

  return {
    date: new Date().toISOString().split('T')[0],
    rates: mapped,
    provider: 'open.er-api.com',
  };
}

function httpsGetText(targetUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout fetching ${targetUrl}`));
    });
  });
}

async function fetchRates({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastRatesFetchAt < RATES_TTL_MS) {
    return rates;
  }
  lastRatesFetchAt = now;

  try {
    const html = await httpsGetText('https://www.cursbnr.ro/');
    const parsed = parseRatesFromCursBnr(html);
    if (Object.keys(parsed.rates).length > 1) {
      rates = parsed;
      return rates;
    }
    throw new Error('Primary provider returned insufficient rates');
  } catch (primaryErr) {
    console.warn('Primary rates provider failed:', primaryErr.message);
    try {
      const payload = await httpsGetText('https://open.er-api.com/v6/latest/RON');
      const fallback = parseFallbackRatesJson(payload);
      if (Object.keys(fallback.rates).length > 1) {
        rates = fallback;
        return rates;
      }
      throw new Error('Fallback provider returned insufficient rates');
    } catch (fallbackErr) {
      console.error('Fallback rates provider failed:', fallbackErr.message);
      return rates;
    }
  }
}

function parseYearMonth(key) {
  if (typeof key !== 'string') return null;
  const [yearRaw, monthRaw] = key.split('-');
  const year = parseInt(yearRaw, 10);
  const month = parseInt(monthRaw, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

function buildMonthlyContributionSeries(currency) {
  const monthly = new Map();
  let minKey = null;
  let maxKey = null;

  investments.forEach((inv) => {
    const date = normalizeDateInput(inv.date);
    if (!date) return;

    const isSale = (typeof inv.units === 'number' && inv.units < 0) || inv.amount < 0;
    if (isSale) return;

    const converted = convertAmount(Math.abs(inv.amount), inv.currency, currency);
    if (converted == null || !Number.isFinite(converted)) return;

    const key = date.slice(0, 7);
    monthly.set(key, (monthly.get(key) || 0) + converted);
    if (!minKey || key < minKey) minKey = key;
    if (!maxKey || key > maxKey) maxKey = key;
  });

  if (!minKey || !maxKey) return [];

  const start = parseYearMonth(minKey);
  const end = parseYearMonth(maxKey);
  if (!start || !end) return [];

  const series = [];
  let y = start.year;
  let m = start.month;

  while (y < end.year || (y === end.year && m <= end.month)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    series.push(monthly.get(key) || 0);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }

  return series;
}

function generateLocalForecast() {
  if (!objective) {
    return 'Set an objective first to generate a forecast.';
  }

  const objectiveCurrency = sanitizeString(objective.currency, 'RON').toUpperCase();
  const targetAmount = parseNumberMaybe(objective.targetAmount);
  if (targetAmount == null || targetAmount <= 0) {
    return 'Set a positive objective target to generate a forecast.';
  }

  const summary = computePortfolioSummary(objectiveCurrency);
  const currentValue = summary.totals.currentValue;
  const remainingGap = targetAmount - currentValue;

  if (remainingGap <= 0) {
    return `Goal reached. Current value is ${currentValue.toFixed(2)} ${objectiveCurrency}, above target ${targetAmount.toFixed(2)} ${objectiveCurrency}.`;
  }

  const monthlySeries = buildMonthlyContributionSeries(objectiveCurrency);
  if (monthlySeries.length === 0) {
    return `No contribution history available yet. Remaining gap is ${remainingGap.toFixed(2)} ${objectiveCurrency}.`;
  }

  const avgMonthlyAll = monthlySeries.reduce((sum, value) => sum + value, 0) / monthlySeries.length;
  const recentWindow = monthlySeries.slice(-Math.min(6, monthlySeries.length));
  const avgMonthlyRecent = recentWindow.reduce((sum, value) => sum + value, 0) / recentWindow.length;
  const effectiveMonthly = (avgMonthlyAll * 0.65) + (avgMonthlyRecent * 0.35);

  if (!Number.isFinite(effectiveMonthly) || effectiveMonthly <= 0.01) {
    return `Unable to estimate timeline from current contribution pattern. Remaining gap is ${remainingGap.toFixed(2)} ${objectiveCurrency}.`;
  }

  const monthsToTarget = Math.max(1, Math.ceil(remainingGap / effectiveMonthly));
  const yearsToTarget = monthsToTarget / 12;
  const eta = new Date();
  eta.setMonth(eta.getMonth() + monthsToTarget);
  const etaDate = eta.toISOString().split('T')[0];

  const durationLabel = monthsToTarget >= 12
    ? `${monthsToTarget} months (~${yearsToTarget.toFixed(yearsToTarget >= 5 ? 1 : 2)} years)`
    : `${monthsToTarget} months`;

  return `Estimated time to goal: ${durationLabel}. Remaining gap: ${remainingGap.toFixed(2)} ${objectiveCurrency}. Based on effective monthly contributions of ${effectiveMonthly.toFixed(2)} ${objectiveCurrency} (recent average: ${avgMonthlyRecent.toFixed(2)}). Estimated completion around ${etaDate}.`;
}

function callPrediction() {
  if (predicting) return;

  predicting = true;
  predictionId = generateId('pred');
  try {
    prediction = generateLocalForecast();
  } catch (err) {
    prediction = 'Forecast generation failed. Please try again.';
    console.error('Forecast generation error:', err);
  } finally {
    predicting = false;
  }
}

function routeApi(pathName, method, body, query, res) {
  if (pathName === '/api/prediction' && method === 'GET') {
    return sendJson(res, 200, { prediction, isGenerating: predicting, predictionId });
  }

  if (pathName === '/api/prediction' && method === 'POST') {
    try {
      callPrediction();
      return sendJson(res, 200, { message: 'Prediction generation started', predictionId });
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to generate prediction' });
    }
  }

  if (pathName === '/api/rates' && method === 'GET') {
    return sendJson(res, 200, rates);
  }

  if (pathName === '/api/portfolio/summary' && method === 'GET') {
    const currency = sanitizeString(query.currency, objective?.currency || 'RON').toUpperCase();
    const summary = computePortfolioSummary(currency);
    return sendJson(res, 200, summary);
  }

  if (pathName === '/api/investments' && method === 'GET') {
    const result = buildQueryResult(investments, query || {});
    return sendJson(res, 200, result.data);
  }

  if (pathName === '/api/investments' && method === 'POST') {
    const parsed = normalizeInvestmentPayload(body, null);
    if (!parsed.ok) {
      return sendJson(res, 400, { error: parsed.error });
    }

    const timestamp = Date.now();
    const inv = {
      id: generateId('inv'),
      timestamp,
      ...parsed.investment,
    };

    investments.push(inv);
    sortInvestmentsByTimestampDesc(investments);
    saveData();
    return sendJson(res, 201, inv);
  }

  if (pathName === '/api/investments/bulk-delete' && method === 'POST') {
    if (!body || !Array.isArray(body.ids)) {
      return sendJson(res, 400, { error: 'ids array is required' });
    }

    const ids = new Set(body.ids.filter((id) => typeof id === 'string' && id));
    const before = investments.length;
    const existingIds = new Set(investments.map((inv) => inv.id));
    const notFound = [];
    ids.forEach((id) => {
      if (!existingIds.has(id)) notFound.push(id);
    });

    investments = investments.filter((inv) => !ids.has(inv.id));
    const deleted = before - investments.length;

    if (deleted > 0) {
      saveData();
    }

    return sendJson(res, 200, {
      deleted,
      requested: ids.size,
      notFound,
      remaining: investments.length,
    });
  }

  if (pathName.startsWith('/api/investments/')) {
    const parts = pathName.split('/');
    const invId = parts[3];

    if (!invId) {
      return sendJson(res, 400, { error: 'Invalid ID' });
    }

    const index = investments.findIndex((inv) => inv.id === invId);
    if (index === -1) {
      return sendJson(res, 404, { error: 'Investment not found' });
    }

    if (method === 'DELETE') {
      investments.splice(index, 1);
      saveData();
      return sendNoContent(res);
    }

    if (method === 'PUT') {
      const existing = investments[index];
      const parsed = normalizeInvestmentPayload(body, existing);
      if (!parsed.ok) {
        return sendJson(res, 400, { error: parsed.error });
      }

      const updated = {
        ...existing,
        ...parsed.investment,
      };
      if (!(typeof updated.units === 'number' && updated.units < 0)) {
        delete updated.isSale;
      }
      investments[index] = updated;
      sortInvestmentsByTimestampDesc(investments);
      saveData();
      return sendJson(res, 200, updated);
    }
  }

  if (pathName === '/api/objective') {
    if (method === 'GET') {
      if (!objective) {
        return sendJson(res, 200, null);
      }
      const summary = computePortfolioSummary(objective.currency);
      return sendJson(res, 200, {
        targetAmount: objective.targetAmount,
        currency: objective.currency,
        currentTotal: summary.totals.currentValue,
      });
    }

    if (method === 'POST') {
      if (!body || typeof body.targetAmount !== 'number' || !body.currency) {
        return sendJson(res, 400, { error: 'Invalid objective payload' });
      }

      objective = {
        targetAmount: body.targetAmount,
        currency: sanitizeString(body.currency, 'RON').toUpperCase(),
      };
      saveData();
      return sendJson(res, 200, objective);
    }
  }

  if (pathName === '/api/net-worth') {
    if (method === 'GET') {
      return sendJson(res, 200, netWorth);
    }

    if (method === 'POST') {
      if (!body || !Array.isArray(body.manualItems)) {
        return sendJson(res, 400, { error: 'Invalid net worth payload' });
      }

      const cleaned = body.manualItems.map((item, idx) => {
        const name = sanitizeString(item.name, `Item ${idx + 1}`);
        const type = item.type === 'liability' ? 'liability' : 'asset';
        const value = parseNumberMaybe(item.value);
        const currency = sanitizeString(item.currency, 'RON').toUpperCase();
        const id = sanitizeString(item.id, generateId('nw'));
        return {
          id,
          name,
          type,
          value: value == null ? 0 : value,
          currency,
        };
      });

      netWorth = { ...netWorth, manualItems: cleaned };
      saveData();
      return sendJson(res, 200, netWorth);
    }
  }

  if (pathName === '/api/milestones') {
    if (method === 'GET') {
      return sendJson(res, 200, { milestones, currency: milestonesCurrency });
    }

    if (method === 'POST') {
      if (!body || !Array.isArray(body.milestones)) {
        return sendJson(res, 400, { error: 'Invalid milestones payload' });
      }

      milestones = body.milestones.map((item, idx) => {
        const target = parseNumberMaybe(item.target);
        const targetDate = normalizeDateInput(item.targetDate) || '';
        const id = sanitizeString(item.id, generateId(`ms${idx}`));
        return {
          id,
          target: target == null ? 0 : target,
          targetDate,
        };
      });

      if (body.currency && typeof body.currency === 'string') {
        milestonesCurrency = body.currency.toUpperCase();
      }

      saveData();
      return sendJson(res, 200, { milestones, currency: milestonesCurrency });
    }
  }

  if (pathName === '/api/profit') {
    if (method === 'GET') {
      return sendJson(res, 200, profitTracker);
    }

    if (method === 'POST') {
      if (!body || (body.entries && !Array.isArray(body.entries))) {
        return sendJson(res, 400, { error: 'Invalid profit payload' });
      }

      if (Array.isArray(body.entries)) {
        profitTracker.entries = body.entries.map((item, idx) => {
          const amount = parseNumberMaybe(item.amount);
          const date = normalizeDateInput(item.date) || '';
          const name = sanitizeString(item.name, '');
          const comment = sanitizeString(item.comment, '');
          const id = sanitizeString(item.id, generateId(`pf${idx}`));
          return {
            id,
            date,
            amount: amount == null ? 0 : amount,
            name,
            comment,
          };
        });
      }

      if (body.settings && typeof body.settings === 'object') {
        const next = { ...profitTracker.settings };

        const minSalary = parseNumberMaybe(body.settings.minSalary);
        if (minSalary != null) next.minSalary = minSalary;

        const cassRate = parseNumberMaybe(body.settings.cassRate);
        if (cassRate != null) next.cassRate = cassRate;

        if (typeof body.settings.currency === 'string') {
          next.currency = body.settings.currency.toUpperCase();
        }

        if (Array.isArray(body.settings.thresholds) && body.settings.thresholds.length > 0) {
          const parsedThresholds = body.settings.thresholds
            .map((t) => parseNumberMaybe(t))
            .filter((t) => t != null);
          if (parsedThresholds.length > 0) {
            next.thresholds = parsedThresholds;
          }
        }

        profitTracker.settings = next;
      }

      saveData();
      return sendJson(res, 200, profitTracker);
    }
  }

  if (pathName === '/api/import/validate' && method === 'POST') {
    if (!body || !Array.isArray(body.investments)) {
      return sendJson(res, 400, { error: 'Invalid import payload' });
    }

    const validation = validateImportRows(body.investments);
    return sendJson(res, 200, validation);
  }

  if (pathName === '/api/import' && method === 'POST') {
    if (!body || !Array.isArray(body.investments)) {
      return sendJson(res, 400, { error: 'Invalid import payload' });
    }

    const mode = sanitizeString(body.mode, 'replace').toLowerCase();
    const validation = validateImportRows(body.investments);

    const created = validation.validRows.map((row) => ({
      id: generateId('inv'),
      timestamp: Date.now() + Math.floor(Math.random() * 1000),
      ...row,
    }));

    if (mode === 'append') {
      investments = investments.concat(created);
    } else {
      investments = created;
    }

    sortInvestmentsByTimestampDesc(investments);
    saveData();

    return sendJson(res, 200, {
      imported: created.length,
      invalid: validation.invalidRows.length,
      invalidRows: validation.invalidRows,
      mode,
      total: investments.length,
    });
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const query = parsed.query || {};

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...CORS_HEADERS,
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (req.method === 'POST' || req.method === 'PUT') {
      parseRequestBody(req, res, (err, payload) => {
        if (err) {
          sendJson(res, 400, { error: err.message || 'Invalid request body' });
          return;
        }
        routeApi(pathname, req.method, payload, query, res);
      });
      return;
    }

    routeApi(pathname, req.method, null, query, res);
    return;
  }

  serveStatic(pathname, req, res).catch((err) => {
    console.error('Static serving error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  });
}

async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, flushing data and shutting down...`);
  if (ratesInterval) {
    clearInterval(ratesInterval);
    ratesInterval = null;
  }

  try {
    await forceFlushData();
  } catch (err) {
    console.error('Error flushing data during shutdown:', err);
  }

  if (server) {
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  } else {
    process.exit(0);
  }
}

function startServer() {
  loadData();

  fetchRates({ force: true }).catch((err) => {
    console.error('Initial rates fetch failed:', err.message);
  });
  ratesInterval = setInterval(() => {
    fetchRates().catch((err) => {
      console.error('Scheduled rates fetch failed:', err.message);
    });
  }, RATES_TTL_MS);

  const PORT = parseInt(process.env.PORT || '3001', 10);
  server = http.createServer(handleRequest);

  server.on('error', (err) => {
    console.error('Server error:', err);
  });

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  process.on('SIGINT', () => {
    gracefulShutdown('SIGINT').catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    gracefulShutdown('SIGTERM').catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  startServer,
  parseRatesFromCursBnr,
  parseFallbackRatesJson,
  convertAmount,
  normalizeInvestmentPayload,
  validateImportRows,
  buildQueryResult,
  computePortfolioSummary,
};
