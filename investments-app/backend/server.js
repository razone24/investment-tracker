const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

/*
 * Investment tracker backend without external dependencies
 *
 * This server provides a REST API and static file hosting without relying
 * on third‑party modules such as Express.  It uses Node's built‑in
 * `http` and `https` modules to handle routing, JSON parsing and CORS
 * headers.  The exchange rates are scraped from https://www.cursbnr.ro/
 * using a simple regular expression.  Data persistence is handled via
 * a JSON file on disk.
 */

// Location where data will be stored
const dataFile = path.join(__dirname, 'data.json');

// In‑memory state
let investments = [];
let objective = null;
let rates = { date: null, rates: { RON: 1 } };

// Store the latest prediction returned by the LLM.  This value will be
// returned to the client via the /api/prediction endpoint.  A small
// flag prevents concurrent calls to the LLM so that multiple rapid
// updates (e.g. during bulk imports) don't queue unnecessary requests.
let prediction = null;
let predicting = false;
let predictionId = null; // Track the current prediction request

/**
 * Build a natural language prompt summarising the current portfolio
 * and objective.  The prompt asks the LLM to estimate how long it
 * might take to reach the target amount given the historical
 * contributions.  The format is intentionally simple to maximise
 * compatibility with different models.  If no objective is set the
 * prompt returns a minimal string.
 */
function generatePrompt() {
  if (!objective) {
    return 'There is currently no investment objective set.';
  }
  const lines = [];
  lines.push(`Target: ${objective.targetAmount} ${objective.currency}`);
  lines.push('Investments:');
  investments.forEach((inv) => {
    lines.push(` - date: ${inv.date}, amount: ${inv.amount} ${inv.currency}, fund: ${inv.fund}, platform: ${inv.platform}`);
  });
  lines.push('Based on the above investment history and the target, estimate how much time it will take to reach the goal.');
  lines.push('Please provide a short answer in this exact format: "It will take you X years" or "It will take you X months" where X is a number.');
  lines.push('Consider one-time investments vs recurring patterns. Be realistic and concise.');
  return lines.join('\n');
}

/**
 * Invoke an Ollama model to generate a prediction.  The model is
 * accessed via the local Ollama API running on port 11434.  The
 * request payload contains the model name, a prompt and disables
 * streaming for simplicity.  Responses are parsed to extract the
 * assistant message.  In case of failure the raw response (or
 * error) is saved to the prediction variable.  Concurrent calls are
 * prevented via the `predicting` flag.
 */
function callPrediction() {
  if (!objective || investments.length === 0) {
    prediction = null;
    return;
  }
  if (predicting) return;
  predicting = true;
  const currentPredictionId = Date.now().toString();
  predictionId = currentPredictionId;
  const prompt = generatePrompt();
  const postData = JSON.stringify({ model: 'llama2', prompt: prompt, stream: false });
  // Allow overriding the Ollama host and port via environment variables.  This
  // makes it easier to connect to an Ollama server running outside of a
  // container (e.g. using host.docker.internal) when the backend runs in
  // Docker.  Defaults remain localhost:11434 for typical usage.
  const ollamaHost = process.env.OLLAMA_HOST || 'localhost';
  const ollamaPortRaw = process.env.OLLAMA_PORT;
  const ollamaPort = ollamaPortRaw ? parseInt(ollamaPortRaw, 10) : 11434;
  const options = {
    hostname: ollamaHost,
    port: ollamaPort,
    path: '/api/generate',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };
  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      predicting = false;
      try {
        const parsed = JSON.parse(data);
        let content = null;
        if (parsed) {
          // Ollama may return { response: 'text' } or { message: { content: 'text' } }
          if (parsed.message && parsed.message.content) {
            content = parsed.message.content;
          } else if (parsed.response) {
            content = parsed.response;
          }
        }
        prediction = content || data;
        console.log('Prediction updated:', prediction);
      } catch (err) {
        prediction = data;
        console.error('Error parsing prediction response:', err);
      }
    });
  });
  req.on('error', (err) => {
    predicting = false;
    prediction = null;
    predictionId = null;
    console.error('Prediction request error:', err);
  });
  req.write(postData);
  req.end();
}

/**
 * Load investments and objective from disk into memory.  If the file
 * does not exist the default empty values remain.
 */
function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      const raw = fs.readFileSync(dataFile, 'utf8');
      const parsed = JSON.parse(raw);
      investments = Array.isArray(parsed.investments) ? parsed.investments : [];
      // Ensure each investment has a numeric timestamp.  Pre‑existing
      // data may only include an `id` field which was derived from
      // `Date.now().toString()`.  If `timestamp` is missing and `id`
      // parses to a number, use that as the timestamp.  This helps
      // maintain ordering when computing latest price per asset.
      investments.forEach((inv) => {
        if (inv.timestamp == null) {
          const ts = parseInt(inv.id, 10);
          if (!isNaN(ts)) {
            inv.timestamp = ts;
          }
        }
      });
      objective = parsed.objective || null;
    }
  } catch (err) {
    console.error('Error reading data file:', err);
  }
}

/**
 * Save investments and objective to disk.  Synchronous write is used
 * because the dataset is expected to be small and concurrency is
 * limited in this environment.
 */
function saveData() {
  try {
    const payload = JSON.stringify({ investments, objective }, null, 2);
    fs.writeFileSync(dataFile, payload);
  } catch (err) {
    console.error('Error writing data file:', err);
  }
}

/**
 * Fetch the HTML from cursbnr.ro and parse currency rates.  The site
 * publishes a table with the latest RON conversions.  A regular
 * expression extracts each currency code and its corresponding value.
 */
function fetchRates() {
  console.log('Fetching latest exchange rates…');
  https
    .get('https://www.cursbnr.ro/', (res) => {
      let html = '';
      res.on('data', (chunk) => (html += chunk));
      res.on('end', () => {
        try {
          const newRates = parseRates(html);
          if (newRates && Object.keys(newRates.rates).length > 1) {
            rates = newRates;
            console.log('Rates updated:', rates.date);
          } else {
            console.warn('No rates parsed from response');
          }
        } catch (err) {
          console.error('Error parsing rates:', err);
        }
      });
    })
    .on('error', (err) => {
      console.error('Error fetching rates:', err);
    });
}

/**
 * Parse currency rates from the HTML of cursbnr.ro.  Returns an object
 * containing the date and a map of currency codes to values in RON.
 *
 * @param {string} html The raw HTML string
 * @returns {{date: string, rates: Object<string, number>}}
 */
function parseRates(html) {
  const result = { date: new Date().toISOString().split('T')[0], rates: { RON: 1 } };
  // Attempt to extract the reporting date from the table header
  const dateMatch = /<th colspan="2" class="text-center">([^<]+)<\/th>/.exec(html);
  if (dateMatch) {
    result.date = dateMatch[1].trim();
  }
  const regex = /<td class="text-center hidden-xs">([^<]+)<\/td>[\s\S]*?<td class="text-center">([0-9.]+)<\/td>/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    let code = m[1].trim();
    let valueStr = m[2].trim();
    const val = parseFloat(valueStr);
    if (!isNaN(val)) {
      let multiplier = 1;
      const multiMatch = code.match(/^(\d+)([A-Z]{3})$/);
      if (multiMatch) {
        multiplier = parseInt(multiMatch[1], 10);
        code = multiMatch[2];
      }
      const normRate = val / multiplier;
      result.rates[code] = normRate;
    }
  }
  return result;
}

/**
 * Convert an amount from one currency to another using the current
 * exchange rates.  Returns null if either currency is unknown.
 */
function convertAmount(amount, from, to) {
  if (!rates.rates[from] || !rates.rates[to]) return null;
  const inRon = amount * rates.rates[from];
  return inRon / rates.rates[to];
}

/**
 * Send a JSON response with the given status code and object.  Adds
 * CORS headers to allow cross‑origin requests from any domain.
 */
function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // Allow DELETE for investment removal
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

/**
 * Serve a static file from the public directory.  If the file does not
 * exist the fallback index.html is returned so that client‑side routing
 * can handle the request.  MIME types are derived from file extension.
 */
function serveStatic(reqPath, res) {
  // If path is root or empty, serve index.html
  let filePath = reqPath;
  if (filePath === '/' || filePath === '') {
    filePath = '/index.html';
  }
  const fullPath = path.join(__dirname, 'public', filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Fallback to index.html for unmatched routes (SPA)
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(indexData);
        }
      });
    } else {
      // Determine basic content type
      let contentType = 'text/plain';
      if (filePath.endsWith('.html')) contentType = 'text/html';
      else if (filePath.endsWith('.css')) contentType = 'text/css';
      else if (filePath.endsWith('.js')) contentType = 'application/javascript';
      else if (filePath.endsWith('.json')) contentType = 'application/json';
      else if (filePath.endsWith('.png')) contentType = 'image/png';
      else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) contentType = 'image/jpeg';
      else if (filePath.endsWith('.svg')) contentType = 'image/svg+xml';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
}

/**
 * Handle incoming HTTP requests.  Routes beginning with `/api/` are
 * treated as API endpoints; all others are served from the public
 * directory.
 */
function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  // Always set CORS headers for preflight requests
  if (req.method === 'OPTIONS') {
    // Include DELETE in allowed methods so that browsers can preflight
    // requests for deletion of investments.  Without this the client
    // would reject the DELETE request due to CORS restrictions.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    // Parse JSON body for POST requests
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let payload = null;
        if (body) {
          try {
            payload = JSON.parse(body);
          } catch (e) {
            return sendJson(res, 400, { error: 'Invalid JSON' });
          }
        }
        routeApi(pathname, req.method, payload, res);
      });
    } else {
      routeApi(pathname, req.method, null, res);
    }
  } else {
    // Static file
    serveStatic(pathname, res);
  }
}

/**
 * Dispatch API requests based on the path and method.
 *
 * @param {string} pathName The request path
 * @param {string} method HTTP method
 * @param {any} body Parsed JSON body (for POST requests)
 * @param {http.ServerResponse} res Response object
 */
function routeApi(pathName, method, body, res) {
  // Expose the latest prediction generated by the LLM.  This returns
  // null when no prediction has been computed or if the objective
  // and investments have not been provided yet.
  if (pathName === '/api/prediction' && method === 'GET') {
    return sendJson(res, 200, { 
      prediction, 
      isGenerating: predicting,
      predictionId 
    });
  }
  // Manual endpoint to trigger prediction generation
  if (pathName === '/api/prediction' && method === 'POST') {
    try {
      callPrediction();
      return sendJson(res, 200, { message: 'Prediction generation started' });
    } catch (e) {
      console.error('Error triggering prediction:', e);
      return sendJson(res, 500, { error: 'Failed to generate prediction' });
    }
  }
  if (pathName === '/api/rates' && method === 'GET') {
    return sendJson(res, 200, rates);
  }
  if (pathName === '/api/investments') {
    if (method === 'GET') {
      return sendJson(res, 200, investments);
    } else if (method === 'POST') {
      // New investments can include the price per unit and the number of units
      // purchased.  If both `unitPrice` and `units` are provided and are
      // numeric, compute the total amount as `unitPrice * units`.  If
      // `amount` is provided instead, use it directly.  Currency, fund,
      // platform and date are always required.
      if (!body || !body.currency || !body.fund || !body.platform || !body.date) {
        return sendJson(res, 400, { error: 'Invalid investment payload' });
      }
      let amount = null;
      if (typeof body.unitPrice === 'number' && typeof body.units === 'number' && body.unitPrice >= 0) {
        // Allow negative units to represent a sale.  The amount will be
        // negative when units < 0, decreasing the invested total.
        amount = body.unitPrice * body.units;
      } else if (typeof body.amount === 'number') {
        amount = body.amount;
      }
      if (amount === null) {
        return sendJson(res, 400, { error: 'Investment must include either amount or unitPrice and units' });
      }
      // Assign a timestamp to preserve the exact insertion order.  This
      // allows us to identify the most recent investment for a given
      // fund even when multiple entries share the same date.  We
      // convert the timestamp to a string for backwards compatibility
      // with pre‑existing data which used the ID as the timestamp.
      const timestamp = Date.now();
      const id = timestamp.toString();
      const newInv = {
        id,
        timestamp,
        amount,
        currency: body.currency.toUpperCase(),
        fund: body.fund,
        platform: body.platform,
        date: body.date,
      };
      // Store unit price and units if provided
      if (typeof body.unitPrice === 'number') newInv.unitPrice = body.unitPrice;
      if (typeof body.units === 'number') newInv.units = body.units;
      // Mark sales explicitly (negative units) for clarity in the UI.  A sale
      // is defined as any entry where units are negative.  This field
      // simplifies filtering and display on the client side, though the
      // calculation logic treats negative units generically.
      if (typeof newInv.units === 'number' && newInv.units < 0) {
        newInv.isSale = true;
      }
      investments.push(newInv);
      saveData();
      return sendJson(res, 201, newInv);
    }
  }
  // DELETE a specific investment by ID.  The ID is provided as part of the
  // URL, e.g. /api/investments/1234567890.  If the investment exists it is
  // removed from the array and persisted.  Returns 204 No Content on
  // success or 404 if the ID does not exist.
  if (pathName.startsWith('/api/investments/') && method === 'DELETE') {
    const parts = pathName.split('/');
    // Expect [ '', 'api', 'investments', '<id>' ]
    const invId = parts.length >= 4 ? parts[3] : null;
    if (!invId) {
      return sendJson(res, 400, { error: 'Invalid ID' });
    }
    const index = investments.findIndex((inv) => inv.id === invId);
    if (index === -1) {
      return sendJson(res, 404, { error: 'Investment not found' });
    }
    investments.splice(index, 1);
    saveData();
    // Send 204 No Content (empty response body)
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (pathName === '/api/objective') {
    if (method === 'GET') {
      if (!objective) {
        return sendJson(res, 200, null);
      }
      // Compute current total value by summing, per fund, the value of known
      // units at the latest unit price plus any investments with unknown unit
      // information converted directly by amount.  For each fund we group
      // investments and determine:
      //   * totalUnits: sum of units across investments where units are known or
      //     can be derived from unitPrice.
      //   * unknownValue: sum of converted amounts for investments where units
      //     cannot be determined.
      //   * latestPrice/latestCurrency: the most recent investment's unit price and
      //     currency.
      // The total value for the fund is (latestPrice * totalUnits) converted to
      // the objective currency plus unknownValue.
      let total = 0;
      const byFund = {};
      for (const inv of investments) {
        if (!byFund[inv.fund]) byFund[inv.fund] = [];
        byFund[inv.fund].push(inv);
      }
      for (const fund in byFund) {
        const invs = byFund[fund];
        // Identify the most recent investment for this fund.  We use
        // the `date` field as the primary ordering key and fall back
        // on `timestamp` (or numeric `id`) to break ties when the
        // dates are equal.  This ensures that if multiple entries share
        // the same date the one added last (highest timestamp) will
        // determine the latest price.
        let latestInv = null;
        invs.forEach((inv) => {
          if (!latestInv) {
            latestInv = inv;
            return;
          }
          if (inv.date > latestInv.date) {
            latestInv = inv;
          } else if (inv.date === latestInv.date) {
            // Compare timestamps (falling back to numeric id if timestamp is missing)
            const currentTs = inv.timestamp != null ? inv.timestamp : parseInt(inv.id, 10);
            const bestTs = latestInv.timestamp != null ? latestInv.timestamp : parseInt(latestInv.id, 10);
            if (!isNaN(currentTs) && !isNaN(bestTs) && currentTs > bestTs) {
              latestInv = inv;
            }
          }
        });
        let latestPrice = null;
        let latestCurrency = null;
        if (latestInv) {
          if (typeof latestInv.unitPrice === 'number') {
            latestPrice = latestInv.unitPrice;
            latestCurrency = latestInv.currency;
          } else if (typeof latestInv.units === 'number' && latestInv.units > 0) {
            latestPrice = latestInv.amount / latestInv.units;
            latestCurrency = latestInv.currency;
          }
        }
        // If we cannot determine a latest price we fallback to converting amounts directly
        if (latestPrice == null || latestCurrency == null) {
          for (const inv of invs) {
            const conv = convertAmount(inv.amount, inv.currency, objective.currency);
            if (conv != null) total += conv;
          }
          continue;
        }
        // Sum units for all investments using the latest price for unknown units
        let totalUnits = 0;
        for (const inv of invs) {
          if (typeof inv.units === 'number') {
            totalUnits += inv.units;
          } else if (typeof inv.unitPrice === 'number') {
            totalUnits += inv.amount / inv.unitPrice;
          } else {
            // Unknown units: convert amount to latest currency then divide by latest price
            const conv = convertAmount(inv.amount, inv.currency, latestCurrency);
            if (conv != null) totalUnits += conv / latestPrice;
          }
        }
        // Compute value: total units times latest price, converted to objective currency
        const valueInLatestCurrency = latestPrice * totalUnits;
        const valueInObjective = convertAmount(valueInLatestCurrency, latestCurrency, objective.currency);
        if (valueInObjective != null) total += valueInObjective;
      }
      return sendJson(res, 200, { targetAmount: objective.targetAmount, currency: objective.currency, currentTotal: total });
    } else if (method === 'POST') {
      if (!body || typeof body.targetAmount !== 'number' || !body.currency) {
        return sendJson(res, 400, { error: 'Invalid objective payload' });
      }
      objective = {
        targetAmount: body.targetAmount,
        currency: body.currency.toUpperCase(),
      };
      saveData();
      return sendJson(res, 200, objective);
    }
  }
  // Import a set of investments from a JSON payload.  The body
  // should contain an `investments` array, each with at least
  // currency, fund, platform, date and either unitPrice and units or
  // amount.  Existing data is replaced entirely with the imported
  // entries.  This route is useful for restoring backups or bulk
  // importing from a file.
  if (pathName === '/api/import' && method === 'POST') {
    if (!body || !Array.isArray(body.investments)) {
      return sendJson(res, 400, { error: 'Invalid import payload' });
    }
    const newInvs = [];
    for (const item of body.investments) {
      // Validate basic fields
      if (!item || !item.currency || !item.fund || !item.platform || !item.date) {
        continue;
      }
      let amount = null;
      // Convert numeric strings to numbers if necessary
      const unitPrice = typeof item.unitPrice === 'number' ? item.unitPrice : parseFloat(item.unitPrice);
      const units = typeof item.units === 'number' ? item.units : parseFloat(item.units);
      const amountVal = typeof item.amount === 'number' ? item.amount : parseFloat(item.amount);
      if (!isNaN(unitPrice) && !isNaN(units) && unitPrice >= 0) {
        amount = unitPrice * units;
      } else if (!isNaN(amountVal)) {
        amount = amountVal;
      } else {
        // Skip entries that do not provide enough info
        continue;
      }
      const timestamp = Date.now();
      const id = timestamp.toString();
      const inv = {
        id,
        timestamp,
        amount,
        currency: item.currency.toUpperCase(),
        fund: item.fund,
        platform: item.platform,
        date: item.date,
      };
      if (!isNaN(unitPrice)) inv.unitPrice = unitPrice;
      if (!isNaN(units)) inv.units = units;
      if (typeof inv.units === 'number' && inv.units < 0) inv.isSale = true;
      newInvs.push(inv);
    }
    investments = newInvs;
    saveData();
    return sendJson(res, 200, { imported: newInvs.length });
  }
  // Unknown API route
  return sendJson(res, 404, { error: 'Not found' });
}

// Initialise application state and schedule periodic tasks
loadData();
fetchRates();
// No longer generate initial prediction automatically
setInterval(fetchRates, 24 * 60 * 60 * 1000);

// Start HTTP server
const PORT = process.env.PORT || 3000;
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
