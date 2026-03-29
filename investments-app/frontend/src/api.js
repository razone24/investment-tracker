const JSON_HEADERS = { 'Content-Type': 'application/json' };

function toQuery(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null) return;
    if (value === '') return;
    query.set(key, String(value));
  });
  return query.toString();
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = typeof data === 'object' && data && data.error ? data.error : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return data;
}

export const api = {
  getRates: () => request('/api/rates'),
  getObjective: () => request('/api/objective'),
  saveObjective: (payload) => request('/api/objective', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }),

  getPrediction: () => request('/api/prediction'),
  triggerPrediction: () => request('/api/prediction', { method: 'POST' }),

  getSummary: (currency) => request(`/api/portfolio/summary?${toQuery({ currency })}`),

  getInvestments: (params = {}) => request(`/api/investments?${toQuery(params)}`),
  getInvestmentsLegacy: () => request('/api/investments?legacy=1'),
  createInvestment: (payload) => request('/api/investments', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }),
  updateInvestment: (id, payload) => request(`/api/investments/${id}`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(payload) }),
  deleteInvestment: (id) => request(`/api/investments/${id}`, { method: 'DELETE' }),
  bulkDeleteInvestments: (ids) => request('/api/investments/bulk-delete', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids }) }),

  validateImport: (rows) => request('/api/import/validate', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ investments: rows }) }),
  importInvestments: (rows, mode = 'replace') => request('/api/import', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ investments: rows, mode }) }),

  getMilestones: () => request('/api/milestones'),
  saveMilestones: (payload) => request('/api/milestones', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }),

  getProfit: () => request('/api/profit'),
  saveProfit: (payload) => request('/api/profit', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) }),

  getNetWorth: () => request('/api/net-worth'),
  saveNetWorth: (manualItems) => request('/api/net-worth', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ manualItems }) }),
};

export { toQuery };
