const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeInvestmentPayload,
  validateImportRows,
  buildQueryResult,
  parseFallbackRatesJson,
} = require('./server');

test('normalizeInvestmentPayload builds amount from unitPrice and units', () => {
  const parsed = normalizeInvestmentPayload({
    unitPrice: 10,
    units: 3,
    currency: 'eur',
    fund: 'ETF',
    platform: 'Broker',
    date: '2026-03-20',
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.investment.amount, 30);
  assert.equal(parsed.investment.currency, 'EUR');
});

test('validateImportRows splits valid and invalid rows', () => {
  const result = validateImportRows([
    {
      unitPrice: 10,
      units: 2,
      currency: 'RON',
      fund: 'A',
      platform: 'P',
      date: '2026-03-20',
    },
    {
      fund: 'Missing fields',
    },
  ]);

  assert.equal(result.validRows.length, 1);
  assert.equal(result.invalidRows.length, 1);
  assert.equal(result.errors.length, 1);
});

test('buildQueryResult supports paginated object mode', () => {
  const source = [
    { id: '1', timestamp: 3, date: '2026-03-03', fund: 'Fund A', platform: 'X', currency: 'RON', amount: 100 },
    { id: '2', timestamp: 2, date: '2026-03-02', fund: 'Fund B', platform: 'Y', currency: 'RON', amount: 200 },
    { id: '3', timestamp: 1, date: '2026-03-01', fund: 'Fund C', platform: 'Y', currency: 'RON', amount: 300 },
  ];

  const result = buildQueryResult(source, { page: 1, pageSize: 2, sortBy: 'amount', sortDir: 'desc' });

  assert.equal(result.legacy, false);
  assert.equal(result.data.total, 3);
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.items[0].amount, 300);
});

test('parseFallbackRatesJson parses open.er-api shape', () => {
  const payload = JSON.stringify({
    rates: {
      USD: 0.22,
      EUR: 0.20,
      RON: 1,
    },
  });

  const parsed = parseFallbackRatesJson(payload);
  assert.equal(parsed.provider, 'open.er-api.com');
  assert.ok(parsed.rates.RON === 1);
  assert.ok(parsed.rates.USD > 0);
});
