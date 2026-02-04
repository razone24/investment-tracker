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
let netWorth = { manualItems: [] };
let milestones = [];
let milestonesCurrency = 'RON';
let profitTracker = {
  entries: [],
  settings: { minSalary: 4050, cassRate: 0.1, thresholds: [6, 12, 24], currency: 'RON' },
};

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
  
  // Group investments by year and month for more compact representation
  const groupedInvestments = {};
  let totalInvested = 0;
  
  investments.forEach((inv) => {
    const date = new Date(inv.date);
    const year = date.getFullYear();
    const month = date.getMonth() + 1; // getMonth() returns 0-11
    const key = `${year}-${month.toString().padStart(2, '0')}`;
    
    if (!groupedInvestments[key]) {
      groupedInvestments[key] = {
        total: 0,
        count: 0,
        funds: new Set(),
        platforms: new Set()
      };
    }
    
    groupedInvestments[key].total += inv.amount;
    groupedInvestments[key].count += 1;
    groupedInvestments[key].funds.add(inv.fund);
    groupedInvestments[key].platforms.add(inv.platform);
    totalInvested += inv.amount;
  });
  
  // Sort by date (newest first)
  const sortedKeys = Object.keys(groupedInvestments).sort().reverse();
  
  // Handle case with no investments
  if (sortedKeys.length === 0) {
    lines.push('No investments recorded yet.');
    lines.push('Based on the target amount, estimate how much time it will take to reach the goal.');
    lines.push('Please provide a short answer in this exact format: "It will take you X years" or "It will take you X months" where X is a number.');
    lines.push('Be realistic and consider that no investments have been made yet.');
    return lines.join('\n');
  }
  
  lines.push(`Total invested: ${totalInvested.toFixed(2)} ${objective.currency}`);
  lines.push(`Investment period: ${sortedKeys[sortedKeys.length - 1]} to ${sortedKeys[0]}`);
  lines.push(`Number of investments: ${investments.length}`);
  
  // If we have too many months, group by quarters or years
  if (sortedKeys.length > 12) {
    // Group by quarters for better readability
    const quarterlyData = {};
    sortedKeys.forEach(key => {
      const [year, month] = key.split('-');
      const quarter = Math.ceil(parseInt(month) / 3);
      const quarterKey = `${year}-Q${quarter}`;
      
      if (!quarterlyData[quarterKey]) {
        quarterlyData[quarterKey] = {
          total: 0,
          count: 0,
          funds: new Set(),
          platforms: new Set()
        };
      }
      
      const data = groupedInvestments[key];
      quarterlyData[quarterKey].total += data.total;
      quarterlyData[quarterKey].count += data.count;
      data.funds.forEach(fund => quarterlyData[quarterKey].funds.add(fund));
      data.platforms.forEach(platform => quarterlyData[quarterKey].platforms.add(platform));
    });
    
    lines.push('Quarterly investment summary:');
    Object.keys(quarterlyData).sort().reverse().forEach(quarter => {
      const data = quarterlyData[quarter];
      lines.push(` - ${quarter}: ${data.total.toFixed(2)} ${objective.currency} (${data.count} investments, ${data.funds.size} funds)`);
    });
  } else {
    // Show monthly breakdown if not too many months
    lines.push('Monthly investment summary:');
    sortedKeys.forEach(key => {
      const data = groupedInvestments[key];
      lines.push(` - ${key}: ${data.total.toFixed(2)} ${objective.currency} (${data.count} investments)`);
    });
  }
  
  // Add fund diversity information
  const allFunds = new Set();
  const allPlatforms = new Set();
  investments.forEach(inv => {
    allFunds.add(inv.fund);
    allPlatforms.add(inv.platform);
  });
  
  lines.push(`Portfolio diversity: ${allFunds.size} different funds across ${allPlatforms.size} platforms`);
  
  // Calculate average monthly investment, excluding significant one-time investments
  const monthsDiff = sortedKeys.length;
  
  // Identify potential one-time investments (outliers)
  const monthlyTotals = sortedKeys.map(key => groupedInvestments[key].total);
  const sortedMonthlyTotals = [...monthlyTotals].sort((a, b) => a - b);
  
  // Calculate median and use it to identify outliers
  const median = sortedMonthlyTotals[Math.floor(sortedMonthlyTotals.length / 2)];
  const q1 = sortedMonthlyTotals[Math.floor(sortedMonthlyTotals.length * 0.25)];
  const q3 = sortedMonthlyTotals[Math.floor(sortedMonthlyTotals.length * 0.75)];
  const iqr = q3 - q1;
  
  // Use a more conservative outlier threshold (0.5 * IQR instead of 1.0 * IQR)
  // and also consider the median as a baseline for "normal" recurring investments
  const outlierThreshold = Math.min(q3 + (0.5 * iqr), median * 1.8);
  
  // Additional check: if the median itself is high, use a percentage of it
  const medianBasedThreshold = median * 1.2;
  const finalThreshold = Math.min(outlierThreshold, medianBasedThreshold);
  
  // Filter out months with outlier investments for recurring calculation
  const recurringMonths = sortedKeys.filter(key => {
    const monthlyTotal = groupedInvestments[key].total;
    return monthlyTotal <= finalThreshold;
  });
  
  const recurringTotal = recurringMonths.reduce((sum, key) => sum + groupedInvestments[key].total, 0);
  const avgMonthlyRecurring = recurringTotal / recurringMonths.length;
  const avgMonthlyAll = totalInvested / monthsDiff;
  
  // Count outlier months
  const outlierMonths = sortedKeys.filter(key => groupedInvestments[key].total > finalThreshold);
  
  if (outlierMonths.length > 0) {
    lines.push(`Recurring monthly investment (excluding outliers): ${avgMonthlyRecurring.toFixed(2)} ${objective.currency}`);
    lines.push(`Overall average (including all): ${avgMonthlyAll.toFixed(2)} ${objective.currency}`);
    lines.push(`One-time investment months: ${outlierMonths.length} (${outlierMonths.map(m => groupedInvestments[m].total.toFixed(0)).join(', ')} ${objective.currency})`);
  } else {
    lines.push(`Average monthly investment: ${avgMonthlyAll.toFixed(2)} ${objective.currency}`);
  }
  
  lines.push('Based on the above investment history and the target, estimate how much time it will take to reach the goal.');
  lines.push('Please provide a short answer in this exact format: "It will take you X years" or "It will take you X months" where X is a number.');
  if (outlierMonths.length > 0) {
    lines.push('Focus on the recurring monthly investment rate, not the overall average which includes one-time large investments.');
  }
  lines.push('Consider one-time investments vs recurring patterns. Be realistic and concise.');
  
  const prompt = lines.join('\n');
  
  // If prompt is still too long, create an even more compact version
  if (prompt.length > 4000) {
    const compactLines = [];
    compactLines.push(`Target: ${objective.targetAmount} ${objective.currency}`);
    compactLines.push(`Total invested: ${totalInvested.toFixed(2)} ${objective.currency}`);
    compactLines.push(`Investment period: ${sortedKeys[sortedKeys.length - 1]} to ${sortedKeys[0]} (${sortedKeys.length} months)`);
    compactLines.push(`Number of investments: ${investments.length}`);
    compactLines.push(`Portfolio diversity: ${allFunds.size} funds across ${allPlatforms.size} platforms`);
    
    // Use the same outlier detection logic for compact version
    const monthlyTotals = sortedKeys.map(key => groupedInvestments[key].total);
    const sortedMonthlyTotals = [...monthlyTotals].sort((a, b) => a - b);
    const median = sortedMonthlyTotals[Math.floor(sortedMonthlyTotals.length / 2)];
    const q1 = sortedMonthlyTotals[Math.floor(sortedMonthlyTotals.length * 0.25)];
    const q3 = sortedMonthlyTotals[Math.floor(sortedMonthlyTotals.length * 0.75)];
    const iqr = q3 - q1;
    
    // Use more conservative outlier detection
    const outlierThreshold = Math.min(q3 + (0.5 * iqr), median * 1.8);
    const medianBasedThreshold = median * 1.2;
    const finalThreshold = Math.min(outlierThreshold, medianBasedThreshold);
    
    const recurringMonths = sortedKeys.filter(key => groupedInvestments[key].total <= finalThreshold);
    const recurringTotal = recurringMonths.reduce((sum, key) => sum + groupedInvestments[key].total, 0);
    const avgMonthlyRecurring = recurringTotal / recurringMonths.length;
    const avgMonthlyAll = totalInvested / sortedKeys.length;
    
    const outlierMonths = sortedKeys.filter(key => groupedInvestments[key].total > finalThreshold);
    
    if (outlierMonths.length > 0) {
      compactLines.push(`Recurring monthly: ${avgMonthlyRecurring.toFixed(2)} ${objective.currency} (excluding ${outlierMonths.length} outlier months)`);
    } else {
      compactLines.push(`Average monthly investment: ${avgMonthlyAll.toFixed(2)} ${objective.currency}`);
    }
    
    // Show only the most recent 6 months if there are many months
    if (sortedKeys.length > 6) {
      compactLines.push('Recent 6 months:');
      sortedKeys.slice(0, 6).forEach(key => {
        const data = groupedInvestments[key];
        compactLines.push(` - ${key}: ${data.total.toFixed(2)} ${objective.currency}`);
      });
    } else {
      compactLines.push('Monthly breakdown:');
      sortedKeys.forEach(key => {
        const data = groupedInvestments[key];
        compactLines.push(` - ${key}: ${data.total.toFixed(2)} ${objective.currency}`);
      });
    }
    
    compactLines.push('Based on the above investment history and the target, estimate how much time it will take to reach the goal.');
    compactLines.push('Please provide a short answer in this exact format: "It will take you X years" or "It will take you X months" where X is a number.');
    if (outlierMonths.length > 0) {
      compactLines.push('Focus on the recurring monthly investment rate, not the overall average which includes one-time large investments.');
    }
    compactLines.push('Consider one-time investments vs recurring patterns. Be realistic and concise.');
    
    return compactLines.join('\n');
  }
  
  return prompt;
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
      // Sort investments by timestamp in descending order (newest first) when loading
      investments.sort((a, b) => b.timestamp - a.timestamp);
      objective = parsed.objective || null;
      netWorth = parsed.netWorth || { manualItems: [] };
      milestonesCurrency = typeof parsed.milestonesCurrency === 'string' && parsed.milestonesCurrency ? parsed.milestonesCurrency : 'RON';
      if (!Array.isArray(netWorth.manualItems) || netWorth.manualItems.length === 0) {
        netWorth.manualItems = defaultNetWorthItems();
      }
      milestones = Array.isArray(parsed.milestones) ? parsed.milestones : [];
      profitTracker = parsed.profitTracker || { entries: [], settings: defaultProfitSettings() };
      if (!Array.isArray(profitTracker.entries)) {
        profitTracker.entries = [];
      }
      if (!profitTracker.settings || typeof profitTracker.settings !== 'object') {
        profitTracker.settings = defaultProfitSettings();
      } else {
        const defaults = defaultProfitSettings();
        if (typeof profitTracker.settings.minSalary !== 'number') {
          profitTracker.settings.minSalary = defaults.minSalary;
        }
        if (typeof profitTracker.settings.cassRate !== 'number') {
          profitTracker.settings.cassRate = defaults.cassRate;
        }
        if (typeof profitTracker.settings.currency !== 'string' || !profitTracker.settings.currency) {
          profitTracker.settings.currency = defaults.currency;
        }
        if (!Array.isArray(profitTracker.settings.thresholds) || profitTracker.settings.thresholds.length === 0) {
          profitTracker.settings.thresholds = defaults.thresholds;
        }
      }
    }
  } catch (err) {
    console.error('Error reading data file:', err);
  }
  if (!Array.isArray(netWorth.manualItems) || netWorth.manualItems.length === 0) {
    netWorth.manualItems = defaultNetWorthItems();
  }
  if (!profitTracker || typeof profitTracker !== 'object') {
    profitTracker = { entries: [], settings: defaultProfitSettings() };
  }
  if (!Array.isArray(profitTracker.entries)) {
    profitTracker.entries = [];
  }
  if (!profitTracker.settings || typeof profitTracker.settings !== 'object') {
    profitTracker.settings = defaultProfitSettings();
  } else if (typeof profitTracker.settings.currency !== 'string' || !profitTracker.settings.currency) {
    profitTracker.settings.currency = defaultProfitSettings().currency;
  }
}

/**
 * Save investments and objective to disk.  Synchronous write is used
 * because the dataset is expected to be small and concurrency is
 * limited in this environment.
 */
function saveData() {
  try {
    const payload = JSON.stringify({ investments, objective, netWorth, milestones, milestonesCurrency, profitTracker }, null, 2);
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
      // Sort investments by timestamp in descending order (newest first) before returning
      const sortedInvestments = [...investments].sort((a, b) => b.timestamp - a.timestamp);
      return sendJson(res, 200, sortedInvestments);
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
      // Sort investments by timestamp in descending order (newest first) after adding
      investments.sort((a, b) => b.timestamp - a.timestamp);
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
  if (pathName === '/api/net-worth') {
    if (method === 'GET') {
      return sendJson(res, 200, netWorth);
    } else if (method === 'POST') {
      if (!body || !Array.isArray(body.manualItems)) {
        return sendJson(res, 400, { error: 'Invalid net worth payload' });
      }
      const cleaned = body.manualItems.map((item, idx) => {
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Item ${idx + 1}`;
        const type = item.type === 'liability' ? 'liability' : 'asset';
        const value = typeof item.value === 'number' ? item.value : parseFloat(item.value);
        const currency = typeof item.currency === 'string' && item.currency ? item.currency.toUpperCase() : 'RON';
        const id = typeof item.id === 'string' && item.id ? item.id : `${Date.now()}-${idx}`;
        return {
          id,
          name,
          type,
          value: isNaN(value) ? 0 : value,
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
    } else if (method === 'POST') {
      if (!body || !Array.isArray(body.milestones)) {
        return sendJson(res, 400, { error: 'Invalid milestones payload' });
      }
      milestones = body.milestones.map((item, idx) => {
        const target = typeof item.target === 'number' ? item.target : parseFloat(item.target);
        const targetDate = typeof item.targetDate === 'string' ? item.targetDate : '';
        const id = typeof item.id === 'string' && item.id ? item.id : `${Date.now()}-${idx}`;
        return {
          id,
          target: isNaN(target) ? 0 : target,
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
    } else if (method === 'POST') {
      if (!body || (body.entries && !Array.isArray(body.entries))) {
        return sendJson(res, 400, { error: 'Invalid profit payload' });
      }
      if (Array.isArray(body.entries)) {
        profitTracker.entries = body.entries.map((item, idx) => {
          const amount = typeof item.amount === 'number' ? item.amount : parseFloat(item.amount);
          const date = typeof item.date === 'string' ? item.date : '';
          const name = typeof item.name === 'string' ? item.name : '';
          const comment = typeof item.comment === 'string' ? item.comment : '';
          const id = typeof item.id === 'string' && item.id ? item.id : `${Date.now()}-${idx}`;
          return {
            id,
            date,
            amount: isNaN(amount) ? 0 : amount,
            name,
            comment,
          };
        });
      }
      if (body.settings && typeof body.settings === 'object') {
        const next = { ...profitTracker.settings };
        if (body.settings.minSalary != null) {
          const minSalary = typeof body.settings.minSalary === 'number' ? body.settings.minSalary : parseFloat(body.settings.minSalary);
          if (!isNaN(minSalary)) next.minSalary = minSalary;
        }
        if (body.settings.cassRate != null) {
          const cassRate = typeof body.settings.cassRate === 'number' ? body.settings.cassRate : parseFloat(body.settings.cassRate);
          if (!isNaN(cassRate)) next.cassRate = cassRate;
        }
        if (body.settings.currency && typeof body.settings.currency === 'string') {
          next.currency = body.settings.currency.toUpperCase();
        }
        if (Array.isArray(body.settings.thresholds) && body.settings.thresholds.length > 0) {
          next.thresholds = body.settings.thresholds.map((t) => (typeof t === 'number' ? t : parseFloat(t))).filter((t) => !isNaN(t));
        }
        profitTracker.settings = next;
      }
      saveData();
      return sendJson(res, 200, profitTracker);
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
    // Sort investments by timestamp in descending order (newest first) after import
    investments.sort((a, b) => b.timestamp - a.timestamp);
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
