export function formatMoney(value, currency) {
  const amount = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(value, digits = 2) {
  const amount = Number.isFinite(value) ? value : 0;
  return amount.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function asDateInput(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function estimateMilestone(target, currentValue, avgMonthlyContribution) {
  const parsedTarget = typeof target === 'number' ? target : parseFloat(target);
  if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) {
    return { status: 'No target', monthsRemaining: null, estDate: '' };
  }
  if (currentValue >= parsedTarget) {
    return { status: 'Reached', monthsRemaining: 0, estDate: asDateInput(new Date()) };
  }
  if (!Number.isFinite(avgMonthlyContribution) || avgMonthlyContribution <= 0) {
    return { status: 'No estimate', monthsRemaining: null, estDate: '' };
  }

  const remaining = parsedTarget - currentValue;
  const monthsRemaining = Math.max(1, Math.ceil(remaining / avgMonthlyContribution));
  const estDate = new Date();
  estDate.setMonth(estDate.getMonth() + monthsRemaining);

  return {
    status: 'In progress',
    monthsRemaining,
    estDate: asDateInput(estDate),
  };
}

export function averageMonthlyContribution(investments, rates, currency, monthsBack = 12) {
  if (!Array.isArray(investments) || investments.length === 0) return 0;
  if (!rates || !rates.rates) return 0;

  const convertAmount = (amount, from, to) => {
    if (!rates.rates[from] || !rates.rates[to]) return 0;
    const inRon = amount * rates.rates[from];
    return inRon / rates.rates[to];
  };

  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);
  const startDate = asDateInput(windowStart);

  let total = 0;
  investments.forEach((inv) => {
    if (!inv.date || inv.date < startDate) return;
    const isSale = (typeof inv.units === 'number' && inv.units < 0) || inv.amount < 0;
    if (isSale) return;
    total += convertAmount(inv.amount, inv.currency, currency);
  });

  return total / monthsBack;
}
