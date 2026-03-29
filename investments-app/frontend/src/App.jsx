import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { asDateInput, averageMonthlyContribution, estimateMilestone, formatMoney, formatNumber } from './lib/portfolio';

const TABS = ['Overview', 'Transactions', 'Planning', 'Tax', 'Settings'];
const SAFE_WITHDRAWAL_PRESETS = [3, 3.5, 4, 4.5, 5];

const DEFAULT_QUERY = {
  page: 1,
  pageSize: 25,
  sortBy: 'date',
  sortDir: 'desc',
  search: '',
  fund: 'All',
  platform: 'All',
  dateFrom: '',
  dateTo: '',
};

const DEFAULT_PROFIT_SETTINGS = {
  minSalary: 4050,
  cassRate: 0.1,
  thresholds: [6, 12, 24],
  currency: 'RON',
};

const DEFAULT_SAFE_WITHDRAWAL = {
  currency: 'RON',
  rate: 4,
  monthlyNeed: 5000,
  includeManualNetWorth: false,
};

function useLocalStorageState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return initialValue;
      return JSON.parse(raw);
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage errors
    }
  }, [key, value]);

  return [value, setValue];
}

function useMediaQuery(query) {
  const getMatches = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);

  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return undefined;
    }

    const mediaQuery = window.matchMedia(query);
    const listener = () => setMatches(mediaQuery.matches);

    listener();

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }

    mediaQuery.addListener(listener);
    return () => mediaQuery.removeListener(listener);
  }, [query, getMatches]);

  return matches;
}

function Card({ title, right, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || right) && (
        <header className="card-header">
          {title && <h3>{title}</h3>}
          {right ? <div>{right}</div> : null}
        </header>
      )}
      {children}
    </section>
  );
}

function Stat({ label, value, note, tone = 'default' }) {
  return (
    <article className={`stat stat-${tone}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {note ? <p className="stat-note">{note}</p> : null}
    </article>
  );
}

function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <button key={toast.id} className={`toast toast-${toast.type || 'info'}`} onClick={() => onDismiss(toast.id)}>
          {toast.message}
        </button>
      ))}
    </div>
  );
}

function SectionHeader({ title, subtitle, actions }) {
  return (
    <header className="section-header">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <div className="section-actions">{actions}</div> : null}
    </header>
  );
}

function FilterChip({ label, onRemove }) {
  return (
    <button className="chip" onClick={onRemove}>
      <span>{label}</span>
      <span aria-hidden="true">×</span>
    </button>
  );
}

function InvestmentForm({ currencies, onSubmit, title, sell = false, funds = [], platforms = [] }) {
  const [form, setForm] = useState({
    unitPrice: '',
    units: '',
    currency: currencies[0] || 'RON',
    fund: '',
    platform: '',
    date: asDateInput(new Date()),
  });

  useEffect(() => {
    if (currencies.length > 0 && !currencies.includes(form.currency)) {
      setForm((prev) => ({ ...prev, currency: currencies[0] }));
    }
  }, [currencies, form.currency]);

  const total = useMemo(() => {
    const price = parseFloat(form.unitPrice);
    const units = parseFloat(form.units);
    if (!Number.isFinite(price) || !Number.isFinite(units)) return null;
    return price * units;
  }, [form.unitPrice, form.units]);

  const handleSubmit = (event) => {
    event.preventDefault();
    const unitPrice = parseFloat(form.unitPrice);
    const unitsRaw = parseFloat(form.units);
    if (!Number.isFinite(unitPrice) || !Number.isFinite(unitsRaw) || unitPrice < 0 || unitsRaw <= 0) {
      return;
    }

    const units = sell ? -Math.abs(unitsRaw) : unitsRaw;
    onSubmit({
      unitPrice,
      units,
      currency: form.currency,
      fund: form.fund || 'Unknown',
      platform: form.platform || 'Unknown',
      date: form.date,
    });

    setForm((prev) => ({ ...prev, unitPrice: '', units: '' }));
  };

  return (
    <Card title={title}>
      <form className="stack" onSubmit={handleSubmit}>
        <label>
          Unit Price
          <input
            type="number"
            min="0"
            step="0.0001"
            value={form.unitPrice}
            onChange={(event) => setForm((prev) => ({ ...prev, unitPrice: event.target.value }))}
            required
          />
        </label>
        <label>
          {sell ? 'Units to Sell' : 'Units'}
          <input
            type="number"
            min="0"
            step="0.0001"
            value={form.units}
            onChange={(event) => setForm((prev) => ({ ...prev, units: event.target.value }))}
            required
          />
        </label>
        {total != null ? (
          <p className="hint-line">
            Total: <strong>{formatNumber(Math.abs(total), 2)}</strong>
          </p>
        ) : null}

        <label>
          Currency
          <select
            value={form.currency}
            onChange={(event) => setForm((prev) => ({ ...prev, currency: event.target.value }))}
          >
            {currencies.map((currency) => (
              <option key={currency} value={currency}>{currency}</option>
            ))}
          </select>
        </label>

        <label>
          Fund / Asset
          <input
            value={form.fund}
            list={sell ? 'fund-list-sell' : 'fund-list-buy'}
            onChange={(event) => setForm((prev) => ({ ...prev, fund: event.target.value }))}
            placeholder="e.g. S&P 500 ETF"
          />
          <datalist id={sell ? 'fund-list-sell' : 'fund-list-buy'}>
            {funds.map((item) => <option key={item} value={item} />)}
          </datalist>
        </label>

        <label>
          Platform
          <input
            value={form.platform}
            list={sell ? 'platform-list-sell' : 'platform-list-buy'}
            onChange={(event) => setForm((prev) => ({ ...prev, platform: event.target.value }))}
            placeholder="e.g. Broker"
          />
          <datalist id={sell ? 'platform-list-sell' : 'platform-list-buy'}>
            {platforms.map((item) => <option key={item} value={item} />)}
          </datalist>
        </label>

        <label>
          Date
          <input
            type="date"
            value={form.date}
            onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
            required
          />
        </label>

        <button type="submit" className={sell ? 'btn-danger' : ''}>{sell ? 'Record Sale' : 'Add Investment'}</button>
      </form>
    </Card>
  );
}

function DistributionChart({ rows, currency, labelKey, title, palette }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let chart = null;

    async function createChart() {
      if (!canvasRef.current) return;
      if (!rows || rows.length === 0) return;

      const module = await import('chart.js/auto');
      const Chart = module.default;

      const labels = rows.map((row) => row[labelKey]);
      const values = rows.map((row) => row.currentValue || 0);

      chart = new Chart(canvasRef.current, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: labels.map((_, index) => palette[index % palette.length]),
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom' },
            title: { display: true, text: `${title} (${currency})` },
          },
        },
      });
    }

    createChart();

    return () => {
      if (chart) chart.destroy();
    };
  }, [rows, currency, labelKey, title, palette]);

  if (!rows || rows.length === 0) {
    return <p className="muted">No chart data yet.</p>;
  }

  return (
    <div className="chart-shell">
      <canvas ref={canvasRef} />
    </div>
  );
}

function AssetEvolutionChart({ rows, selectedAsset, currency }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    let chart = null;
    let isCancelled = false;

    async function createChart() {
      if (!canvasRef.current || !rows.length || !selectedAsset) return;

      const module = await import('chart.js/auto');
      const Chart = module.default;
      if (isCancelled || !canvasRef.current) return;

      chart = new Chart(canvasRef.current, {
        type: 'line',
        data: {
          labels: rows.map((row) => row.date),
          datasets: [
            {
              label: `${selectedAsset} buy`,
              data: rows.map((row) => row.isSale ? null : row.price),
              borderColor: '#0ea5e9',
              backgroundColor: 'rgba(14, 165, 233, 0.2)',
              tension: 0.28,
              pointRadius: 3,
              fill: true,
              spanGaps: true,
            },
            {
              label: `${selectedAsset} sale`,
              data: rows.map((row) => row.isSale ? row.price : null),
              borderColor: '#ef4444',
              backgroundColor: '#ef4444',
              pointRadius: 4,
              pointStyle: 'triangle',
              showLine: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom' },
            title: {
              display: true,
              text: `Asset Evolution (${currency})`,
            },
          },
          scales: {
            x: {
              ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 },
            },
            y: {
              title: { display: true, text: `Unit Price (${currency})` },
            },
          },
        },
      });
    }

    createChart();

    return () => {
      isCancelled = true;
      if (chart) {
        chart.destroy();
      }
    };
  }, [rows, selectedAsset, currency]);

  if (!selectedAsset) {
    return <p className="muted">Choose an asset to see its price evolution.</p>;
  }

  if (!rows.length) {
    return <p className="muted">No transactions available for this asset.</p>;
  }

  return (
    <div className="chart-shell">
      <canvas ref={canvasRef} />
    </div>
  );
}

function VirtualRows({ items, rowHeight = 48, viewportHeight = 420, renderRow }) {
  const [scrollTop, setScrollTop] = useState(0);
  const totalHeight = items.length * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 4);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + 8;
  const endIndex = Math.min(items.length, startIndex + visibleCount);

  const visibleItems = items.slice(startIndex, endIndex);
  const topSpacer = startIndex * rowHeight;
  const bottomSpacer = (items.length - endIndex) * rowHeight;

  return (
    <div
      className="virtual-container"
      style={{ height: `${viewportHeight}px` }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ minHeight: `${totalHeight}px` }}>
        {topSpacer > 0 ? <div style={{ height: `${topSpacer}px` }} /> : null}
        {visibleItems.map((item, index) => renderRow(item, startIndex + index))}
        {bottomSpacer > 0 ? <div style={{ height: `${bottomSpacer}px` }} /> : null}
      </div>
    </div>
  );
}

function App() {
  const systemPrefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const isMobile = useMediaQuery('(max-width: 820px)');
  const [theme, setTheme] = useLocalStorageState('inv_theme', systemPrefersLight ? 'light' : 'dark');
  const [activeTab, setActiveTab] = useLocalStorageState('inv_active_tab', 'Overview');
  const [savedPresets, setSavedPresets] = useLocalStorageState('inv_filter_presets', []);

  const [rates, setRates] = useState({ rates: { RON: 1 } });
  const [currencies, setCurrencies] = useState(['RON']);
  const [displayCurrency, setDisplayCurrency] = useLocalStorageState('inv_display_currency', 'RON');
  const [selectedEvolutionAsset, setSelectedEvolutionAsset] = useLocalStorageState('inv_asset_evolution_asset', '');
  const [safeWithdrawal, setSafeWithdrawal] = useLocalStorageState('inv_safe_withdrawal', DEFAULT_SAFE_WITHDRAWAL);
  const safeWithdrawalConfig = useMemo(
    () => ({ ...DEFAULT_SAFE_WITHDRAWAL, ...(safeWithdrawal && typeof safeWithdrawal === 'object' ? safeWithdrawal : {}) }),
    [safeWithdrawal]
  );

  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState('');

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  const [objective, setObjective] = useState(null);
  const [objectiveForm, setObjectiveForm] = useState({ targetAmount: '', currency: 'RON' });
  const [prediction, setPrediction] = useState('');
  const [isGeneratingPrediction, setIsGeneratingPrediction] = useState(false);

  const [allInvestments, setAllInvestments] = useState([]);

  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [transactions, setTransactions] = useState({ items: [], total: 0, page: 1, pageSize: 25 });
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState('');

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [editingInvestment, setEditingInvestment] = useState(null);

  const [importPreview, setImportPreview] = useState({ open: false, fileName: '', rows: [], validation: null, mode: 'replace' });
  const [importBusy, setImportBusy] = useState(false);

  const [milestones, setMilestones] = useState([]);
  const [milestonesCurrency, setMilestonesCurrency] = useState('RON');
  const [milestonesDirty, setMilestonesDirty] = useState(false);

  const [profitEntries, setProfitEntries] = useState([]);
  const [profitSettings, setProfitSettings] = useState(DEFAULT_PROFIT_SETTINGS);
  const [profitCurrency, setProfitCurrency] = useState('RON');
  const [profitDirty, setProfitDirty] = useState(false);

  const [netWorthItems, setNetWorthItems] = useState([]);
  const [netWorthCurrency, setNetWorthCurrency] = useState('RON');
  const [netWorthDirty, setNetWorthDirty] = useState(false);

  const [toasts, setToasts] = useState([]);

  const pushToast = useCallback((message, type = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 3200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const convertAmount = useCallback((amount, from, to) => {
    if (!rates.rates[from] || !rates.rates[to]) return 0;
    const inRon = amount * rates.rates[from];
    return inRon / rates.rates[to];
  }, [rates]);

  const refreshSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const data = await api.getSummary(displayCurrency);
      setSummary(data);
    } catch (error) {
      setSummaryError(error.message || 'Failed to load portfolio summary');
    } finally {
      setSummaryLoading(false);
    }
  }, [displayCurrency]);

  const refreshObjective = useCallback(async () => {
    try {
      const data = await api.getObjective();
      setObjective(data || null);
      if (data) {
        setObjectiveForm({
          targetAmount: data.targetAmount,
          currency: data.currency,
        });
      }
    } catch {
      // non-blocking
    }
  }, []);

  const refreshAllInvestments = useCallback(async () => {
    try {
      const data = await api.getInvestmentsLegacy();
      setAllInvestments(Array.isArray(data) ? data : []);
    } catch {
      setAllInvestments([]);
    }
  }, []);

  const loadTransactions = useCallback(async (nextQuery = query) => {
    setTransactionsLoading(true);
    setTransactionsError('');
    try {
      const params = {
        ...nextQuery,
        fund: nextQuery.fund === 'All' ? '' : nextQuery.fund,
        platform: nextQuery.platform === 'All' ? '' : nextQuery.platform,
      };
      const data = await api.getInvestments(params);
      setTransactions({
        items: Array.isArray(data.items) ? data.items : [],
        total: data.total || 0,
        page: data.page || nextQuery.page,
        pageSize: data.pageSize || nextQuery.pageSize,
      });
      setSelectedIds(new Set());
    } catch (error) {
      setTransactionsError(error.message || 'Failed to load transactions');
    } finally {
      setTransactionsLoading(false);
    }
  }, [query]);

  const bootstrap = useCallback(async () => {
    setBootstrapLoading(true);
    setBootstrapError('');
    try {
      const [ratesData, predictionData, milestonesData, profitData, netWorthData] = await Promise.all([
        api.getRates(),
        api.getPrediction().catch(() => ({ prediction: '' })),
        api.getMilestones().catch(() => ({ milestones: [], currency: 'RON' })),
        api.getProfit().catch(() => ({ entries: [], settings: DEFAULT_PROFIT_SETTINGS })),
        api.getNetWorth().catch(() => ({ manualItems: [] })),
      ]);

      setRates(ratesData || { rates: { RON: 1 } });
      const currencyList = Object.keys(ratesData?.rates || { RON: 1 }).sort();
      setCurrencies(currencyList);

      if (!currencyList.includes(displayCurrency)) {
        setDisplayCurrency(currencyList.includes('RON') ? 'RON' : currencyList[0] || 'RON');
      }

      setPrediction(predictionData?.prediction || '');

      setMilestones(Array.isArray(milestonesData?.milestones) ? milestonesData.milestones : []);
      if (typeof milestonesData?.currency === 'string') {
        setMilestonesCurrency(milestonesData.currency);
      }

      setProfitEntries(Array.isArray(profitData?.entries) ? profitData.entries : []);
      setProfitSettings({ ...DEFAULT_PROFIT_SETTINGS, ...(profitData?.settings || {}) });
      if (typeof profitData?.settings?.currency === 'string') {
        setProfitCurrency(profitData.settings.currency);
      }

      setNetWorthItems(Array.isArray(netWorthData?.manualItems) ? netWorthData.manualItems : []);
    } catch (error) {
      setBootstrapError(error.message || 'Failed to initialize app');
    } finally {
      setBootstrapLoading(false);
    }
  }, [displayCurrency, setDisplayCurrency]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    refreshObjective();
    refreshSummary();
    refreshAllInvestments();
  }, [refreshObjective, refreshSummary, refreshAllInvestments]);

  useEffect(() => {
    loadTransactions(query);
  }, [query, loadTransactions]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const fundOptions = useMemo(() => {
    if (!summary?.byFund) return [];
    return summary.byFund.map((item) => item.fund).filter(Boolean);
  }, [summary]);

  const platformOptions = useMemo(() => {
    if (!summary?.byPlatform) return [];
    return summary.byPlatform.map((item) => item.platform).filter(Boolean);
  }, [summary]);

  const evolutionAssetOptions = useMemo(() => {
    const set = new Set();
    allInvestments.forEach((item) => {
      if (item?.fund) set.add(item.fund);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allInvestments]);

  useEffect(() => {
    if (!evolutionAssetOptions.length) {
      if (selectedEvolutionAsset) setSelectedEvolutionAsset('');
      return;
    }
    if (!selectedEvolutionAsset || !evolutionAssetOptions.includes(selectedEvolutionAsset)) {
      setSelectedEvolutionAsset(evolutionAssetOptions[0]);
    }
  }, [evolutionAssetOptions, selectedEvolutionAsset, setSelectedEvolutionAsset]);

  useEffect(() => {
    if (!currencies.length) return;
    if (currencies.includes(safeWithdrawalConfig.currency)) return;
    const fallback = currencies.includes('RON') ? 'RON' : currencies[0];
    setSafeWithdrawal((prev) => ({ ...prev, currency: fallback }));
  }, [currencies, safeWithdrawalConfig.currency, setSafeWithdrawal]);

  const activeFilterChips = useMemo(() => {
    const chips = [];
    if (query.search) chips.push({ key: 'search', label: `Search: ${query.search}` });
    if (query.fund !== 'All') chips.push({ key: 'fund', label: `Fund: ${query.fund}` });
    if (query.platform !== 'All') chips.push({ key: 'platform', label: `Platform: ${query.platform}` });
    if (query.dateFrom) chips.push({ key: 'dateFrom', label: `From: ${query.dateFrom}` });
    if (query.dateTo) chips.push({ key: 'dateTo', label: `To: ${query.dateTo}` });
    return chips;
  }, [query]);

  const objectiveProgress = useMemo(() => {
    if (!objective || !summary) return 0;
    if (!Number.isFinite(objective.targetAmount) || objective.targetAmount <= 0) return 0;
    return Math.min(100, (objective.currentTotal / objective.targetAmount) * 100);
  }, [objective, summary]);

  const avgContributionMilestones = useMemo(() => averageMonthlyContribution(allInvestments, rates, milestonesCurrency), [allInvestments, rates, milestonesCurrency]);

  const assetEvolutionRows = useMemo(() => {
    if (!selectedEvolutionAsset) return [];

    return allInvestments
      .filter((row) => row.fund === selectedEvolutionAsset)
      .map((row) => {
        let unitPrice = null;
        if (typeof row.unitPrice === 'number' && Number.isFinite(row.unitPrice)) {
          unitPrice = row.unitPrice;
        } else if (typeof row.amount === 'number' && typeof row.units === 'number' && row.units !== 0) {
          unitPrice = row.amount / row.units;
        }
        if (!Number.isFinite(unitPrice)) {
          return null;
        }
        const converted = convertAmount(unitPrice, row.currency, displayCurrency);
        const isSale = (typeof row.units === 'number' && row.units < 0) || row.amount < 0;
        return {
          id: row.id,
          date: row.date,
          timestamp: typeof row.timestamp === 'number' ? row.timestamp : 0,
          price: Math.abs(converted),
          isSale,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.timestamp - b.timestamp;
      });
  }, [allInvestments, selectedEvolutionAsset, convertAmount, displayCurrency]);

  const netWorthTotals = useMemo(() => {
    const manual = netWorthItems.reduce(
      (acc, item) => {
        const amount = typeof item.value === 'number' ? item.value : parseFloat(item.value || 0);
        const converted = convertAmount(Number.isFinite(amount) ? amount : 0, item.currency || netWorthCurrency, netWorthCurrency);
        if (item.type === 'liability') {
          acc.liabilities += converted;
        } else {
          acc.assets += converted;
        }
        return acc;
      },
      { assets: 0, liabilities: 0 }
    );
    const portfolio = summary ? convertAmount(summary.totals.currentValue, summary.currency, netWorthCurrency) : 0;
    return {
      portfolio,
      ...manual,
      total: portfolio + manual.assets - manual.liabilities,
    };
  }, [netWorthItems, netWorthCurrency, summary, convertAmount]);

  const yearlyProfit = useMemo(() => {
    const grouped = profitEntries.reduce((acc, item) => {
      const year = item.date ? item.date.slice(0, 4) : 'Unknown';
      const amount = typeof item.amount === 'number' ? item.amount : parseFloat(item.amount || 0);
      acc[year] = (acc[year] || 0) + (Number.isFinite(amount) ? amount : 0);
      return acc;
    }, {});

    return Object.keys(grouped)
      .sort()
      .map((year) => ({ year, total: grouped[year] }));
  }, [profitEntries]);

  const currentPortfolioInMilestoneCurrency = useMemo(() => {
    if (!summary) return 0;
    return convertAmount(summary.totals.currentValue, summary.currency, milestonesCurrency);
  }, [summary, milestonesCurrency, convertAmount]);

  const milestoneInsights = useMemo(() => {
    const today = asDateInput(new Date());
    const rows = milestones.map((item) => {
      const estimate = estimateMilestone(item.target, currentPortfolioInMilestoneCurrency, avgContributionMilestones);
      const target = parseFloat(item.target || 0);
      const progress = target > 0 ? Math.max(0, Math.min(100, (currentPortfolioInMilestoneCurrency / target) * 100)) : 0;
      const isAtRisk = Boolean(item.targetDate && estimate.estDate && estimate.estDate > item.targetDate);
      const isOverdue = Boolean(item.targetDate && today > item.targetDate && estimate.status !== 'Reached');
      return {
        ...item,
        estimate,
        progress,
        isAtRisk,
        isOverdue,
      };
    });
    return rows;
  }, [milestones, currentPortfolioInMilestoneCurrency, avgContributionMilestones]);

  const milestoneHealth = useMemo(() => {
    return milestoneInsights.reduce(
      (acc, item) => {
        if (item.estimate.status === 'Reached') acc.reached += 1;
        else if (item.isOverdue || item.isAtRisk) acc.atRisk += 1;
        else acc.onTrack += 1;
        return acc;
      },
      { reached: 0, onTrack: 0, atRisk: 0 }
    );
  }, [milestoneInsights]);

  const safeWithdrawalSnapshot = useMemo(() => {
    const targetCurrency = safeWithdrawalConfig.currency || 'RON';
    const portfolioCapital = summary ? convertAmount(summary.totals.currentValue, summary.currency, targetCurrency) : 0;
    const manualCapital = convertAmount(netWorthTotals.assets - netWorthTotals.liabilities, netWorthCurrency, targetCurrency);
    const capitalBase = safeWithdrawalConfig.includeManualNetWorth ? portfolioCapital + manualCapital : portfolioCapital;
    const swrRate = Number.isFinite(parseFloat(safeWithdrawalConfig.rate)) ? parseFloat(safeWithdrawalConfig.rate) : 4;
    const monthlyNeed = Number.isFinite(parseFloat(safeWithdrawalConfig.monthlyNeed)) ? parseFloat(safeWithdrawalConfig.monthlyNeed) : 0;
    const requiredCapital = swrRate > 0 ? (monthlyNeed * 12) / (swrRate / 100) : 0;

    return {
      currency: targetCurrency,
      capitalBase,
      requiredCapital,
      monthlyNeed,
      swrRate,
      rows: SAFE_WITHDRAWAL_PRESETS.map((rate) => {
        const annual = capitalBase * (rate / 100);
        return {
          rate,
          annual,
          monthly: annual / 12,
        };
      }),
    };
  }, [safeWithdrawalConfig, summary, convertAmount, netWorthTotals, netWorthCurrency]);

  const handlePrediction = async () => {
    setIsGeneratingPrediction(true);
    try {
      await api.triggerPrediction();
      const startedAt = Date.now();

      const poll = async () => {
        const data = await api.getPrediction();
        const stillGenerating = data?.isGenerating;
        if (data?.prediction) {
          setPrediction(data.prediction);
        }
        if (stillGenerating && Date.now() - startedAt < 90_000) {
          window.setTimeout(poll, 1200);
        } else {
          setIsGeneratingPrediction(false);
        }
      };

      poll();
    } catch (error) {
      setIsGeneratingPrediction(false);
      pushToast(error.message || 'Failed to generate forecast', 'error');
    }
  };

  const updateQuery = (patch) => {
    setQuery((prev) => ({ ...prev, ...patch, page: patch.page || (patch.pageSize ? 1 : prev.page) }));
  };

  const resetFilters = () => {
    setQuery((prev) => ({ ...prev, ...DEFAULT_QUERY, pageSize: prev.pageSize }));
  };

  const removeFilterChip = (key) => {
    const patch = { [key]: key === 'fund' || key === 'platform' ? 'All' : '' };
    updateQuery({ ...patch, page: 1 });
  };

  const toggleSort = (field) => {
    setQuery((prev) => {
      if (prev.sortBy !== field) {
        return { ...prev, sortBy: field, sortDir: 'asc', page: 1 };
      }
      return { ...prev, sortDir: prev.sortDir === 'asc' ? 'desc' : 'asc', page: 1 };
    });
  };

  const saveCurrentPreset = () => {
    const name = window.prompt('Preset name');
    if (!name) return;
    const preset = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: name.trim(),
      query: {
        search: query.search,
        fund: query.fund,
        platform: query.platform,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        sortBy: query.sortBy,
        sortDir: query.sortDir,
        pageSize: query.pageSize,
      },
    };
    setSavedPresets((prev) => [...prev, preset]);
    pushToast(`Saved preset "${preset.name}"`);
  };

  const applyPreset = (preset) => {
    if (!preset?.query) return;
    setQuery((prev) => ({
      ...prev,
      ...preset.query,
      page: 1,
    }));
  };

  const deletePreset = (id) => {
    setSavedPresets((prev) => prev.filter((preset) => preset.id !== id));
  };

  const refreshAfterMutation = async () => {
    await Promise.all([refreshSummary(), refreshObjective(), refreshAllInvestments(), loadTransactions()]);
  };

  const handleCreateInvestment = async (payload) => {
    try {
      await api.createInvestment(payload);
      pushToast('Investment saved', 'success');
      await refreshAfterMutation();
    } catch (error) {
      pushToast(error.message || 'Failed to save investment', 'error');
    }
  };

  const handleDeleteSingle = async (id) => {
    try {
      await api.deleteInvestment(id);
      pushToast('Transaction deleted', 'success');
      await refreshAfterMutation();
    } catch (error) {
      pushToast(error.message || 'Failed to delete transaction', 'error');
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    try {
      const ids = Array.from(selectedIds);
      const result = await api.bulkDeleteInvestments(ids);
      pushToast(`Deleted ${result.deleted} transactions`, 'success');
      setSelectedIds(new Set());
      await refreshAfterMutation();
    } catch (error) {
      pushToast(error.message || 'Bulk delete failed', 'error');
    }
  };

  const toggleSelectRow = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectVisibleRows = (checked) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      transactions.items.forEach((item) => {
        if (checked) next.add(item.id);
        else next.delete(item.id);
      });
      return next;
    });
  };

  const openEditModal = (investment) => {
    setEditingInvestment({
      ...investment,
      unitPrice: investment.unitPrice ?? (typeof investment.units === 'number' && investment.units !== 0 ? investment.amount / investment.units : ''),
      units: investment.units ?? '',
    });
  };

  const saveEditedInvestment = async () => {
    if (!editingInvestment) return;
    const payload = {
      fund: editingInvestment.fund,
      platform: editingInvestment.platform,
      currency: editingInvestment.currency,
      date: editingInvestment.date,
      unitPrice: parseFloat(editingInvestment.unitPrice),
      units: parseFloat(editingInvestment.units),
    };

    try {
      await api.updateInvestment(editingInvestment.id, payload);
      setEditingInvestment(null);
      pushToast('Transaction updated', 'success');
      await refreshAfterMutation();
    } catch (error) {
      pushToast(error.message || 'Update failed', 'error');
    }
  };

  const handleImportFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const extension = file.name.split('.').pop().toLowerCase();
      let rows = [];

      if (extension === 'json') {
        const text = await file.text();
        rows = JSON.parse(text);
      } else if (extension === 'xls' || extension === 'xlsx') {
        const xlsx = await import('xlsx');
        const buffer = await file.arrayBuffer();
        const workbook = xlsx.read(new Uint8Array(buffer), { type: 'array' });
        const first = workbook.SheetNames[0];
        rows = xlsx.utils.sheet_to_json(workbook.Sheets[first]);
      } else {
        pushToast('Unsupported import format', 'error');
        return;
      }

      if (!Array.isArray(rows)) {
        pushToast('Import file must contain an array of rows', 'error');
        return;
      }

      const validation = await api.validateImport(rows);
      setImportPreview({ open: true, fileName: file.name, rows, validation, mode: 'replace' });
    } catch (error) {
      pushToast(error.message || 'Failed to parse import file', 'error');
    }
  };

  const applyImport = async () => {
    if (!importPreview.open || importBusy) return;
    setImportBusy(true);
    try {
      const result = await api.importInvestments(importPreview.rows, importPreview.mode);
      pushToast(`Imported ${result.imported} transactions`, 'success');
      setImportPreview({ open: false, fileName: '', rows: [], validation: null, mode: 'replace' });
      await refreshAfterMutation();
    } catch (error) {
      pushToast(error.message || 'Import failed', 'error');
    } finally {
      setImportBusy(false);
    }
  };

  const exportJson = async () => {
    try {
      const rows = await api.getInvestmentsLegacy();
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = 'investments-export.json';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(href);
    } catch (error) {
      pushToast(error.message || 'JSON export failed', 'error');
    }
  };

  const exportExcel = async () => {
    try {
      const rows = await api.getInvestmentsLegacy();
      const xlsx = await import('xlsx');
      const worksheet = xlsx.utils.json_to_sheet(rows);
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, worksheet, 'Investments');
      xlsx.writeFile(workbook, 'investments-export.xlsx');
    } catch (error) {
      pushToast(error.message || 'Excel export failed', 'error');
    }
  };

  const saveObjective = async () => {
    try {
      const payload = {
        targetAmount: parseFloat(objectiveForm.targetAmount),
        currency: objectiveForm.currency,
      };
      await api.saveObjective(payload);
      await refreshObjective();
      await refreshSummary();
      pushToast('Objective updated', 'success');
    } catch (error) {
      pushToast(error.message || 'Failed to save objective', 'error');
    }
  };

  const addMilestone = () => {
    const oneYearOut = new Date();
    oneYearOut.setFullYear(oneYearOut.getFullYear() + 1);
    setMilestones((prev) => [...prev, { id: `ms-${Date.now()}`, target: 0, targetDate: asDateInput(oneYearOut) }]);
    setMilestonesDirty(true);
  };

  const updateMilestone = (id, patch) => {
    setMilestones((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setMilestonesDirty(true);
  };

  const removeMilestone = (id) => {
    setMilestones((prev) => prev.filter((item) => item.id !== id));
    setMilestonesDirty(true);
  };

  const saveMilestones = async () => {
    try {
      await api.saveMilestones({ milestones, currency: milestonesCurrency });
      setMilestonesDirty(false);
      pushToast('Milestones saved', 'success');
    } catch (error) {
      pushToast(error.message || 'Failed to save milestones', 'error');
    }
  };

  const addProfitEntry = () => {
    setProfitEntries((prev) => [...prev, { id: `pf-${Date.now()}`, date: asDateInput(new Date()), amount: 0, name: '', comment: '' }]);
    setProfitDirty(true);
  };

  const updateProfitEntry = (id, patch) => {
    setProfitEntries((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setProfitDirty(true);
  };

  const removeProfitEntry = (id) => {
    setProfitEntries((prev) => prev.filter((item) => item.id !== id));
    setProfitDirty(true);
  };

  const saveProfit = async () => {
    try {
      await api.saveProfit({ entries: profitEntries, settings: { ...profitSettings, currency: profitCurrency } });
      setProfitDirty(false);
      pushToast('Profit tracker saved', 'success');
    } catch (error) {
      pushToast(error.message || 'Failed to save profit tracker', 'error');
    }
  };

  const addNetWorthItem = () => {
    setNetWorthItems((prev) => [...prev, { id: `nw-${Date.now()}`, name: 'New Item', type: 'asset', value: 0, currency: netWorthCurrency }]);
    setNetWorthDirty(true);
  };

  const updateNetWorthItem = (id, patch) => {
    setNetWorthItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    setNetWorthDirty(true);
  };

  const removeNetWorthItem = (id) => {
    setNetWorthItems((prev) => prev.filter((item) => item.id !== id));
    setNetWorthDirty(true);
  };

  const saveNetWorth = async () => {
    try {
      await api.saveNetWorth(netWorthItems);
      setNetWorthDirty(false);
      pushToast('Net worth items saved', 'success');
    } catch (error) {
      pushToast(error.message || 'Failed to save net worth', 'error');
    }
  };

  const updateSafeWithdrawal = (patch) => {
    setSafeWithdrawal((prev) => ({
      ...DEFAULT_SAFE_WITHDRAWAL,
      ...(prev && typeof prev === 'object' ? prev : {}),
      ...patch,
    }));
  };

  const allVisibleSelected = transactions.items.length > 0 && transactions.items.every((row) => selectedIds.has(row.id));

  const renderTransactionRow = (row) => {
    const isSale = (typeof row.units === 'number' && row.units < 0) || row.amount < 0;
    const valueInDisplay = convertAmount(row.amount, row.currency, displayCurrency);
    const computedUnitPrice = typeof row.unitPrice === 'number'
      ? row.unitPrice
      : (typeof row.units === 'number' && row.units !== 0 ? row.amount / row.units : null);

    return (
      <div key={row.id} className={`row-grid ${isSale ? 'row-sale' : ''}`}>
        <div>
          <input
            type="checkbox"
            checked={selectedIds.has(row.id)}
            onChange={() => toggleSelectRow(row.id)}
            aria-label={`Select transaction ${row.id}`}
          />
        </div>
        <div>{row.date}</div>
        <div>{row.fund}</div>
        <div>{row.platform}</div>
        <div>{computedUnitPrice != null ? formatNumber(computedUnitPrice, 4) : '—'}</div>
        <div>{typeof row.units === 'number' ? formatNumber(row.units, 4) : '—'}</div>
        <div>{formatNumber(row.amount, 2)} {row.currency}</div>
        <div>{formatNumber(valueInDisplay, 2)} {displayCurrency}</div>
        <div className="row-actions">
          <button onClick={() => openEditModal(row)}>Edit</button>
          <button className="btn-danger" onClick={() => handleDeleteSingle(row.id)}>Delete</button>
        </div>
      </div>
    );
  };

  const renderTransactionCard = (row) => {
    const isSale = (typeof row.units === 'number' && row.units < 0) || row.amount < 0;
    const valueInDisplay = convertAmount(row.amount, row.currency, displayCurrency);
    const computedUnitPrice = typeof row.unitPrice === 'number'
      ? row.unitPrice
      : (typeof row.units === 'number' && row.units !== 0 ? row.amount / row.units : null);

    return (
      <article key={row.id} className={`transaction-card ${isSale ? 'row-sale' : ''}`}>
        <header>
          <label className="inline-checkbox">
            <input
              type="checkbox"
              checked={selectedIds.has(row.id)}
              onChange={() => toggleSelectRow(row.id)}
              aria-label={`Select transaction ${row.id}`}
            />
            <span>{row.date}</span>
          </label>
          <span className={`pill ${isSale ? 'pill-sale' : 'pill-buy'}`}>{isSale ? 'Sale' : 'Buy'}</span>
        </header>
        <dl>
          <div>
            <dt>Fund</dt>
            <dd>{row.fund}</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>{row.platform}</dd>
          </div>
          <div>
            <dt>Unit Price</dt>
            <dd>{computedUnitPrice != null ? formatNumber(computedUnitPrice, 4) : '—'}</dd>
          </div>
          <div>
            <dt>Units</dt>
            <dd>{typeof row.units === 'number' ? formatNumber(row.units, 4) : '—'}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{formatNumber(row.amount, 2)} {row.currency}</dd>
          </div>
          <div>
            <dt>Display Value</dt>
            <dd>{formatNumber(valueInDisplay, 2)} {displayCurrency}</dd>
          </div>
        </dl>
        <div className="row-actions">
          <button onClick={() => openEditModal(row)}>Edit</button>
          <button className="btn-danger" onClick={() => handleDeleteSingle(row.id)}>Delete</button>
        </div>
      </article>
    );
  };

  if (bootstrapLoading) {
    return (
      <div className="app-shell">
        <div className="hero-skeleton" />
        <div className="grid-2">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      </div>
    );
  }

  if (bootstrapError) {
    return (
      <div className="app-shell">
        <Card title="Initialization Failed">
          <p className="error-text">{bootstrapError}</p>
          <button onClick={bootstrap}>Retry</button>
        </Card>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <header className="hero">
        <div>
          <p className="hero-kicker">Investment Control Center</p>
          <h1>Investment Tracker</h1>
          <p className="hero-subtitle">Fast portfolio operations, clearer planning, and reliable progress tracking.</p>
        </div>
        <div className="hero-controls">
          <label>
            Display Currency
            <select value={displayCurrency} onChange={(event) => setDisplayCurrency(event.target.value)}>
              {currencies.map((currency) => (
                <option key={currency} value={currency}>{currency}</option>
              ))}
            </select>
          </label>
          <button onClick={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}>
            Theme: {theme}
          </button>
        </div>
      </header>

      <nav className="tab-nav" aria-label="Main sections">
        {TABS.map((tab) => (
          <button
            key={tab}
            className={tab === activeTab ? 'active' : ''}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      {activeTab === 'Overview' && (
        <main className="content-stack">
          <SectionHeader
            title="Portfolio Snapshot"
            subtitle="Precomputed summary from the server with current valuation and P/L deltas."
            actions={<button onClick={refreshSummary} disabled={summaryLoading}>{summaryLoading ? 'Refreshing...' : 'Refresh'}</button>}
          />

          {summaryError ? <p className="error-text">{summaryError}</p> : null}

          <div className="stats-grid">
            <Stat label="Invested" value={summary ? formatMoney(summary.totals.invested, summary.currency) : '—'} />
            <Stat label="Current Value" value={summary ? formatMoney(summary.totals.currentValue, summary.currency) : '—'} tone="accent" />
            <Stat label="Unrealized" value={summary ? formatMoney(summary.totals.unrealizedDelta, summary.currency) : '—'} tone={summary && summary.totals.unrealizedDelta >= 0 ? 'positive' : 'negative'} />
            <Stat label="Realized" value={summary ? formatMoney(summary.totals.realizedDelta, summary.currency) : '—'} tone={summary && summary.totals.realizedDelta >= 0 ? 'positive' : 'negative'} />
          </div>

          <div className="grid-2">
            <Card title="Objective">
              <div className="stack">
                <label>
                  Target Amount
                  <input
                    type="number"
                    value={objectiveForm.targetAmount}
                    onChange={(event) => setObjectiveForm((prev) => ({ ...prev, targetAmount: event.target.value }))}
                  />
                </label>
                <label>
                  Currency
                  <select
                    value={objectiveForm.currency}
                    onChange={(event) => setObjectiveForm((prev) => ({ ...prev, currency: event.target.value }))}
                  >
                    {currencies.map((currency) => (
                      <option key={currency} value={currency}>{currency}</option>
                    ))}
                  </select>
                </label>
                <button onClick={saveObjective}>Save Objective</button>

                {objective ? (
                  <>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${objectiveProgress}%` }} />
                    </div>
                    <p className="muted">
                      {formatNumber(objective.currentTotal, 2)} / {formatNumber(objective.targetAmount, 2)} {objective.currency}
                    </p>
                  </>
                ) : <p className="muted">Set your objective to unlock a forecast.</p>}

                <div className="stack compact">
                  <button onClick={handlePrediction} disabled={isGeneratingPrediction || !objective}>
                    {isGeneratingPrediction ? 'Generating forecast...' : 'Generate Forecast'}
                  </button>
                  <p className="prediction-box">{prediction || 'No forecast generated yet.'}</p>
                </div>
              </div>
            </Card>

            <Card
              title="Distribution"
              right={
                <small className="muted">Source date: {summary?.ratesDate || 'n/a'}</small>
              }
            >
              <DistributionChart
                rows={summary?.byFund || []}
                currency={summary?.currency || displayCurrency}
                labelKey="fund"
                title="By Fund"
                palette={['#d97706', '#0ea5e9', '#22c55e', '#ef4444', '#0891b2', '#84cc16', '#f97316', '#1d4ed8']}
              />
            </Card>
          </div>

          <div className="grid-2">
            <Card
              title="Asset Evolution"
              right={
                <label className="compact-label">
                  Asset
                  <select
                    value={selectedEvolutionAsset}
                    onChange={(event) => setSelectedEvolutionAsset(event.target.value)}
                  >
                    {evolutionAssetOptions.length === 0 ? <option value="">No assets</option> : null}
                    {evolutionAssetOptions.map((fund) => (
                      <option key={fund} value={fund}>{fund}</option>
                    ))}
                  </select>
                </label>
              }
            >
              <AssetEvolutionChart
                rows={assetEvolutionRows}
                selectedAsset={selectedEvolutionAsset}
                currency={displayCurrency}
              />
            </Card>

            <Card title="Milestones Snapshot">
              <div className="stats-grid stats-grid-compact">
                <Stat label="Reached" value={formatNumber(milestoneHealth.reached, 0)} tone="positive" />
                <Stat label="On Track" value={formatNumber(milestoneHealth.onTrack, 0)} />
                <Stat label="At Risk" value={formatNumber(milestoneHealth.atRisk, 0)} tone={milestoneHealth.atRisk > 0 ? 'negative' : 'default'} />
              </div>
              <div className="milestone-mini-list">
                {milestoneInsights.length === 0 ? (
                  <p className="muted">No milestones set yet. Add them in the Planning tab.</p>
                ) : milestoneInsights.slice(0, 4).map((item) => (
                  <article key={item.id} className={`milestone-mini ${item.isOverdue || item.isAtRisk ? 'milestone-risk' : ''}`}>
                    <p><strong>{formatMoney(item.target, milestonesCurrency)}</strong></p>
                    <p className="muted">
                      Target: {item.targetDate || 'No date'} • Est: {item.estimate.estDate || 'n/a'}
                    </p>
                  </article>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Fund Drill-Down">
              {isMobile ? (
                <div className="data-card-list">
                  {(summary?.byFund || []).map((row) => (
                    <article key={row.fund} className="data-card">
                      <p><strong>{row.fund}</strong></p>
                      <div className="data-card-grid">
                        <p><span className="muted">Units:</span> {formatNumber(row.units, 4)}</p>
                        <p><span className="muted">Invested:</span> {formatMoney(row.invested, summary.currency)}</p>
                        <p><span className="muted">Current:</span> {formatMoney(row.currentValue, summary.currency)}</p>
                        <p><span className="muted">Realized:</span> {formatMoney(row.realizedDelta, summary.currency)}</p>
                        <p><span className="muted">Unrealized:</span> {formatMoney(row.unrealizedDelta, summary.currency)}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-scroll">
                  <div className="table-grid table-grid-fund">
                    <div>Fund</div><div>Units</div><div>Invested</div><div>Current</div><div>Realized</div><div>Unrealized</div>
                    {(summary?.byFund || []).map((row) => (
                      <React.Fragment key={row.fund}>
                        <div>{row.fund}</div>
                        <div>{formatNumber(row.units, 4)}</div>
                        <div>{formatMoney(row.invested, summary.currency)}</div>
                        <div>{formatMoney(row.currentValue, summary.currency)}</div>
                        <div>{formatMoney(row.realizedDelta, summary.currency)}</div>
                        <div>{formatMoney(row.unrealizedDelta, summary.currency)}</div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card title="Platform Drill-Down">
              {isMobile ? (
                <div className="data-card-list">
                  {(summary?.byPlatform || []).map((row) => (
                    <article key={row.platform} className="data-card">
                      <p><strong>{row.platform}</strong></p>
                      <div className="data-card-grid">
                        <p><span className="muted">Funds:</span> {row.funds}</p>
                        <p><span className="muted">Invested:</span> {formatMoney(row.invested, summary.currency)}</p>
                        <p><span className="muted">Current:</span> {formatMoney(row.currentValue, summary.currency)}</p>
                        <p><span className="muted">P/L:</span> {formatMoney(row.pnlTotal, summary.currency)}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-scroll">
                  <div className="table-grid table-grid-platform">
                    <div>Platform</div><div>Funds</div><div>Invested</div><div>Current</div><div>P/L</div>
                    {(summary?.byPlatform || []).map((row) => (
                      <React.Fragment key={row.platform}>
                        <div>{row.platform}</div>
                        <div>{row.funds}</div>
                        <div>{formatMoney(row.invested, summary.currency)}</div>
                        <div>{formatMoney(row.currentValue, summary.currency)}</div>
                        <div>{formatMoney(row.pnlTotal, summary.currency)}</div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </main>
      )}

      {activeTab === 'Transactions' && (
        <main className="content-stack">
          <SectionHeader
            title="Transaction Operations"
            subtitle="Search, sort, edit, bulk actions, and validated import workflow."
            actions={
              <div className="inline-actions">
                <button onClick={saveCurrentPreset}>Save Filter Preset</button>
                <button onClick={resetFilters}>Reset Filters</button>
              </div>
            }
          />

          <div className="grid-2">
            <InvestmentForm
              currencies={currencies}
              funds={fundOptions}
              platforms={platformOptions}
              title="Add Investment"
              onSubmit={handleCreateInvestment}
            />
            <InvestmentForm
              currencies={currencies}
              funds={fundOptions}
              platforms={platformOptions}
              title="Record Sale"
              sell
              onSubmit={handleCreateInvestment}
            />
          </div>

          <Card title="Filters & Presets">
            <div className="filters-grid">
              <label>
                Search
                <input
                  value={query.search}
                  onChange={(event) => updateQuery({ search: event.target.value, page: 1 })}
                  placeholder="Fund, platform, date..."
                />
              </label>
              <label>
                Fund
                <select value={query.fund} onChange={(event) => updateQuery({ fund: event.target.value, page: 1 })}>
                  <option value="All">All</option>
                  {fundOptions.map((fund) => <option key={fund} value={fund}>{fund}</option>)}
                </select>
              </label>
              <label>
                Platform
                <select value={query.platform} onChange={(event) => updateQuery({ platform: event.target.value, page: 1 })}>
                  <option value="All">All</option>
                  {platformOptions.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
                </select>
              </label>
              <label>
                From
                <input type="date" value={query.dateFrom} onChange={(event) => updateQuery({ dateFrom: event.target.value, page: 1 })} />
              </label>
              <label>
                To
                <input type="date" value={query.dateTo} onChange={(event) => updateQuery({ dateTo: event.target.value, page: 1 })} />
              </label>
              <label>
                Page Size
                <select
                  value={query.pageSize}
                  onChange={(event) => updateQuery({ pageSize: parseInt(event.target.value, 10), page: 1 })}
                >
                  {[10, 25, 50, 100, 250].map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
            </div>

            <div className="chips-line">
              {activeFilterChips.map((chip) => (
                <FilterChip key={chip.key} label={chip.label} onRemove={() => removeFilterChip(chip.key)} />
              ))}
            </div>

            <div className="preset-line">
              {savedPresets.length === 0 ? (
                <p className="muted">No presets yet.</p>
              ) : savedPresets.map((preset) => (
                <div className="preset-pill" key={preset.id}>
                  <button onClick={() => applyPreset(preset)}>{preset.name}</button>
                  <button className="plain-danger" onClick={() => deletePreset(preset.id)} aria-label={`Delete ${preset.name}`}>×</button>
                </div>
              ))}
            </div>
          </Card>

          <Card
            title="Import / Export"
            right={
              <div className="inline-actions">
                <button onClick={exportJson}>Export JSON</button>
                <button onClick={exportExcel}>Export Excel</button>
              </div>
            }
          >
            <div className="import-line">
              <input type="file" accept=".json,.xls,.xlsx" onChange={handleImportFile} />
              <span className="muted">Import runs validation first; invalid rows are listed before apply.</span>
            </div>
          </Card>

          <Card
            title="Transactions"
            right={
              <div className="inline-actions">
                <label className="inline-checkbox">
                  <input type="checkbox" checked={allVisibleSelected} onChange={(event) => selectVisibleRows(event.target.checked)} />
                  Select page
                </label>
                <button className="btn-danger" disabled={selectedIds.size === 0} onClick={handleBulkDelete}>
                  Delete Selected ({selectedIds.size})
                </button>
              </div>
            }
          >
            {transactionsError ? <p className="error-text">{transactionsError}</p> : null}
            {transactionsLoading ? <p className="muted">Loading transactions...</p> : null}

            {isMobile ? (
              <div className="mobile-sort-row">
                <span className="muted">Sort:</span>
                <button onClick={() => toggleSort('date')}>Date</button>
                <button onClick={() => toggleSort('fund')}>Fund</button>
                <button onClick={() => toggleSort('amount')}>Amount</button>
              </div>
            ) : (
              <div className="row-grid row-grid-header">
                <button onClick={() => toggleSort('date')}>Date</button>
                <button onClick={() => toggleSort('fund')}>Fund</button>
                <button onClick={() => toggleSort('platform')}>Platform</button>
                <button onClick={() => toggleSort('unitPrice')}>Unit Price</button>
                <button onClick={() => toggleSort('units')}>Units</button>
                <button onClick={() => toggleSort('amount')}>Amount</button>
              </div>
            )}

            {transactions.items.length === 0 ? (
              <p className="muted">No transactions for current filter.</p>
            ) : !isMobile && transactions.items.length > 40 ? (
              <VirtualRows items={transactions.items} renderRow={renderTransactionRow} />
            ) : isMobile ? (
              <div className="transaction-card-list">
                {transactions.items.map((item) => renderTransactionCard(item))}
              </div>
            ) : (
              <div className="rows-list">
                {transactions.items.map((item) => renderTransactionRow(item))}
              </div>
            )}

            <div className="pagination">
              <button disabled={query.page <= 1} onClick={() => updateQuery({ page: query.page - 1 })}>Previous</button>
              <span>Page {query.page} / {Math.max(1, Math.ceil((transactions.total || 0) / query.pageSize))}</span>
              <button
                disabled={query.page >= Math.ceil((transactions.total || 0) / query.pageSize)}
                onClick={() => updateQuery({ page: query.page + 1 })}
              >
                Next
              </button>
            </div>
          </Card>
        </main>
      )}

      {activeTab === 'Planning' && (
        <main className="content-stack">
          <SectionHeader title="Milestones & Net Worth" subtitle="Plan future targets with contribution-based estimates." />

          <div className="stats-grid stats-grid-compact">
            <Stat label="Current Portfolio" value={formatMoney(currentPortfolioInMilestoneCurrency, milestonesCurrency)} tone="accent" />
            <Stat label="Reached Milestones" value={formatNumber(milestoneHealth.reached, 0)} tone="positive" />
            <Stat label="At Risk / Overdue" value={formatNumber(milestoneHealth.atRisk, 0)} tone={milestoneHealth.atRisk > 0 ? 'negative' : 'default'} />
            <Stat label="Avg Monthly Contribution" value={formatMoney(avgContributionMilestones, milestonesCurrency)} />
          </div>

          <div className="grid-2">
            <Card title="Milestones" right={<button onClick={addMilestone}>Add</button>}>
              <p className="muted">Use target dates to catch at-risk goals before they slip.</p>
              <label>
                Milestone Currency
                <select value={milestonesCurrency} onChange={(event) => { setMilestonesCurrency(event.target.value); setMilestonesDirty(true); }}>
                  {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>
              {isMobile ? (
                <div className="data-card-list">
                  {milestoneInsights.map((item) => {
                    const estimateLabel = item.estimate.estDate
                      ? `${item.estimate.estDate}${item.estimate.monthsRemaining != null ? ` (${item.estimate.monthsRemaining} mo)` : ''}`
                      : '—';
                    const statusLabel = item.isOverdue
                      ? 'Overdue'
                      : item.isAtRisk
                        ? 'At risk'
                        : item.estimate.status;

                    return (
                      <article key={item.id} className="data-card">
                        <label>
                          Target
                          <input
                            type="number"
                            value={item.target}
                            onChange={(event) => updateMilestone(item.id, { target: parseFloat(event.target.value || 0) })}
                          />
                        </label>
                        <label>
                          Target Date
                          <input
                            type="date"
                            value={item.targetDate || ''}
                            onChange={(event) => updateMilestone(item.id, { targetDate: event.target.value })}
                          />
                        </label>
                        <p><span className="muted">Progress:</span> {formatNumber(item.progress, 1)}%</p>
                        <p><span className="muted">Estimate:</span> {estimateLabel}</p>
                        <p className={item.isOverdue || item.isAtRisk ? 'status-negative' : 'status-positive'}>{statusLabel}</p>
                        <div className="data-card-actions">
                          <button className="btn-danger" onClick={() => removeMilestone(item.id)}>Remove</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="table-scroll">
                  <div className="table-grid table-grid-milestones">
                    <div>Target</div><div>Progress</div><div>Target Date</div><div>Estimate</div><div>Status</div><div />
                    {milestoneInsights.map((item) => {
                      const estimateLabel = item.estimate.estDate
                        ? `${item.estimate.estDate}${item.estimate.monthsRemaining != null ? ` (${item.estimate.monthsRemaining} mo)` : ''}`
                        : '—';
                      const statusLabel = item.isOverdue
                        ? 'Overdue'
                        : item.isAtRisk
                          ? 'At risk'
                          : item.estimate.status;

                      return (
                        <React.Fragment key={item.id}>
                          <div>
                            <input
                              type="number"
                              value={item.target}
                              onChange={(event) => updateMilestone(item.id, { target: parseFloat(event.target.value || 0) })}
                            />
                          </div>
                          <div>{formatNumber(item.progress, 1)}%</div>
                          <div>
                            <input
                              type="date"
                              value={item.targetDate || ''}
                              onChange={(event) => updateMilestone(item.id, { targetDate: event.target.value })}
                            />
                          </div>
                          <div>{estimateLabel}</div>
                          <div className={item.isOverdue || item.isAtRisk ? 'status-negative' : 'status-positive'}>{statusLabel}</div>
                          <div><button className="btn-danger" onClick={() => removeMilestone(item.id)}>Remove</button></div>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              )}
              <button onClick={saveMilestones} disabled={!milestonesDirty}>Save Milestones</button>
            </Card>

            <Card title="Net Worth" right={<button onClick={addNetWorthItem}>Add Item</button>}>
              <label>
                Display Currency
                <select value={netWorthCurrency} onChange={(event) => setNetWorthCurrency(event.target.value)}>
                  {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>

              <div className="stats-inline">
                <p><strong>Portfolio:</strong> {formatMoney(netWorthTotals.portfolio, netWorthCurrency)}</p>
                <p><strong>Assets:</strong> {formatMoney(netWorthTotals.assets, netWorthCurrency)}</p>
                <p><strong>Liabilities:</strong> {formatMoney(netWorthTotals.liabilities, netWorthCurrency)}</p>
                <p><strong>Total:</strong> {formatMoney(netWorthTotals.total, netWorthCurrency)}</p>
              </div>

              {isMobile ? (
                <div className="data-card-list">
                  {netWorthItems.map((item) => (
                    <article key={item.id} className="data-card">
                      <label>
                        Name
                        <input value={item.name || ''} onChange={(event) => updateNetWorthItem(item.id, { name: event.target.value })} />
                      </label>
                      <label>
                        Type
                        <select value={item.type || 'asset'} onChange={(event) => updateNetWorthItem(item.id, { type: event.target.value })}>
                          <option value="asset">Asset</option>
                          <option value="liability">Liability</option>
                        </select>
                      </label>
                      <label>
                        Value
                        <input type="number" value={item.value} onChange={(event) => updateNetWorthItem(item.id, { value: parseFloat(event.target.value || 0) })} />
                      </label>
                      <label>
                        Currency
                        <select value={item.currency || netWorthCurrency} onChange={(event) => updateNetWorthItem(item.id, { currency: event.target.value })}>
                          {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                        </select>
                      </label>
                      <div className="data-card-actions">
                        <button className="btn-danger" onClick={() => removeNetWorthItem(item.id)}>Remove</button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-scroll">
                  <div className="table-grid table-grid-networth">
                    <div>Name</div><div>Type</div><div>Value</div><div>Currency</div><div />
                    {netWorthItems.map((item) => (
                      <React.Fragment key={item.id}>
                        <div><input value={item.name || ''} onChange={(event) => updateNetWorthItem(item.id, { name: event.target.value })} /></div>
                        <div>
                          <select value={item.type || 'asset'} onChange={(event) => updateNetWorthItem(item.id, { type: event.target.value })}>
                            <option value="asset">Asset</option>
                            <option value="liability">Liability</option>
                          </select>
                        </div>
                        <div><input type="number" value={item.value} onChange={(event) => updateNetWorthItem(item.id, { value: parseFloat(event.target.value || 0) })} /></div>
                        <div>
                          <select value={item.currency || netWorthCurrency} onChange={(event) => updateNetWorthItem(item.id, { currency: event.target.value })}>
                            {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                          </select>
                        </div>
                        <div><button className="btn-danger" onClick={() => removeNetWorthItem(item.id)}>Remove</button></div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              <button onClick={saveNetWorth} disabled={!netWorthDirty}>Save Net Worth</button>
            </Card>
          </div>

          <div className="grid-2">
            <Card title="Safe Withdrawal Planner">
              <div className="filters-grid filters-grid-compact">
                <label>
                  Currency
                  <select value={safeWithdrawalConfig.currency} onChange={(event) => updateSafeWithdrawal({ currency: event.target.value })}>
                    {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                  </select>
                </label>
                <label>
                  Target SWR %
                  <select value={safeWithdrawalConfig.rate} onChange={(event) => updateSafeWithdrawal({ rate: parseFloat(event.target.value) })}>
                    {SAFE_WITHDRAWAL_PRESETS.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
                  </select>
                </label>
                <label>
                  Desired Monthly Spend
                  <input
                    type="number"
                    min="0"
                    value={safeWithdrawalConfig.monthlyNeed}
                    onChange={(event) => updateSafeWithdrawal({ monthlyNeed: parseFloat(event.target.value || 0) })}
                  />
                </label>
              </div>
              <label className="inline-checkbox">
                <input
                  type="checkbox"
                  checked={safeWithdrawalConfig.includeManualNetWorth}
                  onChange={(event) => updateSafeWithdrawal({ includeManualNetWorth: event.target.checked })}
                />
                Include manual net-worth items in capital base
              </label>

              <div className="stats-inline">
                <p><strong>Capital Base:</strong> {formatMoney(safeWithdrawalSnapshot.capitalBase, safeWithdrawalSnapshot.currency)}</p>
                <p><strong>Required Capital:</strong> {formatMoney(safeWithdrawalSnapshot.requiredCapital, safeWithdrawalSnapshot.currency)} at {safeWithdrawalSnapshot.swrRate}%</p>
                <p className={safeWithdrawalSnapshot.capitalBase >= safeWithdrawalSnapshot.requiredCapital ? 'status-positive' : 'status-negative'}>
                  {safeWithdrawalSnapshot.capitalBase >= safeWithdrawalSnapshot.requiredCapital ? 'On track for target spend' : 'Below target spend capital'}
                </p>
              </div>

              {isMobile ? (
                <div className="swr-rate-list">
                  {safeWithdrawalSnapshot.rows.map((row) => (
                    <article key={row.rate} className="data-card">
                      <p><strong>{row.rate}% SWR</strong></p>
                      <p><span className="muted">Annual:</span> {formatMoney(row.annual, safeWithdrawalSnapshot.currency)}</p>
                      <p><span className="muted">Monthly:</span> {formatMoney(row.monthly, safeWithdrawalSnapshot.currency)}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-scroll">
                  <div className="table-grid table-grid-swr">
                    <div>SWR</div><div>Annual</div><div>Monthly</div>
                    {safeWithdrawalSnapshot.rows.map((row) => (
                      <React.Fragment key={row.rate}>
                        <div>{row.rate}%</div>
                        <div>{formatMoney(row.annual, safeWithdrawalSnapshot.currency)}</div>
                        <div>{formatMoney(row.monthly, safeWithdrawalSnapshot.currency)}</div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card title="Milestone Timeline">
              <div className="milestone-mini-list">
                {milestoneInsights.length === 0 ? (
                  <p className="muted">No milestones available.</p>
                ) : milestoneInsights
                  .slice()
                  .sort((a, b) => {
                    if (!a.targetDate && !b.targetDate) return 0;
                    if (!a.targetDate) return 1;
                    if (!b.targetDate) return -1;
                    return a.targetDate.localeCompare(b.targetDate);
                  })
                  .map((item) => (
                    <article key={`timeline-${item.id}`} className={`milestone-mini ${item.isOverdue || item.isAtRisk ? 'milestone-risk' : ''}`}>
                      <p><strong>{formatMoney(item.target, milestonesCurrency)}</strong></p>
                      <p className="muted">Target date: {item.targetDate || 'No date'}</p>
                      <p className="muted">Estimate: {item.estimate.estDate || 'n/a'}</p>
                    </article>
                  ))}
              </div>
            </Card>
          </div>
        </main>
      )}

      {activeTab === 'Tax' && (
        <main className="content-stack">
          <SectionHeader title="Profit Tracker" subtitle="Track annual profits and estimate CASS obligations." />
          <div className="grid-2">
            <Card title="Settings">
              <label>
                Display Currency
                <select value={profitCurrency} onChange={(event) => { setProfitCurrency(event.target.value); setProfitDirty(true); }}>
                  {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>
              <label>
                Minimum Salary (RON)
                <input
                  type="number"
                  value={profitSettings.minSalary}
                  onChange={(event) => {
                    setProfitSettings((prev) => ({ ...prev, minSalary: parseFloat(event.target.value || 0) }));
                    setProfitDirty(true);
                  }}
                />
              </label>
              <label>
                CASS Rate
                <input
                  type="number"
                  step="0.01"
                  value={profitSettings.cassRate}
                  onChange={(event) => {
                    setProfitSettings((prev) => ({ ...prev, cassRate: parseFloat(event.target.value || 0) }));
                    setProfitDirty(true);
                  }}
                />
              </label>
              <div className="hint-line">
                {(profitSettings.thresholds || []).map((item) => (
                  <span key={item}>{item}x = {(profitSettings.minSalary * item).toFixed(2)} RON</span>
                ))}
              </div>
            </Card>

            <Card title="Yearly Summary">
              {isMobile ? (
                <div className="data-card-list">
                  {yearlyProfit.map((row) => (
                    <article key={row.year} className="data-card">
                      <p><strong>{row.year}</strong></p>
                      <p>{formatMoney(row.total, profitCurrency)}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="table-scroll">
                  <div className="table-grid table-grid-profit-year">
                    <div>Year</div><div>Total</div>
                    {yearlyProfit.map((row) => (
                      <React.Fragment key={row.year}>
                        <div>{row.year}</div>
                        <div>{formatMoney(row.total, profitCurrency)}</div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>

          <Card title="Entries" right={<button onClick={addProfitEntry}>Add Entry</button>}>
            {isMobile ? (
              <div className="data-card-list">
                {profitEntries.map((entry) => (
                  <article key={entry.id} className="data-card">
                    <label>
                      Date
                      <input type="date" value={entry.date || ''} onChange={(event) => updateProfitEntry(entry.id, { date: event.target.value })} />
                    </label>
                    <label>
                      Profit
                      <input type="number" value={entry.amount} onChange={(event) => updateProfitEntry(entry.id, { amount: parseFloat(event.target.value || 0) })} />
                    </label>
                    <label>
                      Name
                      <input value={entry.name || ''} onChange={(event) => updateProfitEntry(entry.id, { name: event.target.value })} />
                    </label>
                    <label>
                      Comment
                      <input value={entry.comment || ''} onChange={(event) => updateProfitEntry(entry.id, { comment: event.target.value })} />
                    </label>
                    <div className="data-card-actions">
                      <button className="btn-danger" onClick={() => removeProfitEntry(entry.id)}>Remove</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="table-scroll">
                <div className="table-grid table-grid-profit">
                  <div>Date</div><div>Profit</div><div>Name</div><div>Comment</div><div />
                  {profitEntries.map((entry) => (
                    <React.Fragment key={entry.id}>
                      <div><input type="date" value={entry.date || ''} onChange={(event) => updateProfitEntry(entry.id, { date: event.target.value })} /></div>
                      <div><input type="number" value={entry.amount} onChange={(event) => updateProfitEntry(entry.id, { amount: parseFloat(event.target.value || 0) })} /></div>
                      <div><input value={entry.name || ''} onChange={(event) => updateProfitEntry(entry.id, { name: event.target.value })} /></div>
                      <div><input value={entry.comment || ''} onChange={(event) => updateProfitEntry(entry.id, { comment: event.target.value })} /></div>
                      <div><button className="btn-danger" onClick={() => removeProfitEntry(entry.id)}>Remove</button></div>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}
            <button onClick={saveProfit} disabled={!profitDirty}>Save Profit Tracker</button>
          </Card>
        </main>
      )}

      {activeTab === 'Settings' && (
        <main className="content-stack">
          <SectionHeader title="Preferences" subtitle="Theme and defaults are stored locally." />
          <div className="grid-2">
            <Card title="Appearance">
              <label>
                Theme
                <select value={theme} onChange={(event) => setTheme(event.target.value)}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <p className="muted">Theme preference is persisted and can be changed any time.</p>
            </Card>
            <Card title="Performance Notes">
              <ul className="clean-list">
                <li>Server-side pagination and filtering are active for transactions.</li>
                <li>Chart rendering is lazy-loaded only when needed.</li>
                <li>Import/export spreadsheet library is loaded on demand.</li>
                <li>Bulk actions and edit flow use dedicated API endpoints.</li>
              </ul>
            </Card>
          </div>
        </main>
      )}

      {editingInvestment ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Edit Transaction</h3>
            <div className="stack">
              <label>
                Fund
                <input value={editingInvestment.fund} onChange={(event) => setEditingInvestment((prev) => ({ ...prev, fund: event.target.value }))} />
              </label>
              <label>
                Platform
                <input value={editingInvestment.platform} onChange={(event) => setEditingInvestment((prev) => ({ ...prev, platform: event.target.value }))} />
              </label>
              <label>
                Currency
                <select value={editingInvestment.currency} onChange={(event) => setEditingInvestment((prev) => ({ ...prev, currency: event.target.value }))}>
                  {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                </select>
              </label>
              <label>
                Date
                <input type="date" value={editingInvestment.date} onChange={(event) => setEditingInvestment((prev) => ({ ...prev, date: event.target.value }))} />
              </label>
              <label>
                Unit Price
                <input type="number" value={editingInvestment.unitPrice} onChange={(event) => setEditingInvestment((prev) => ({ ...prev, unitPrice: event.target.value }))} />
              </label>
              <label>
                Units
                <input type="number" value={editingInvestment.units} onChange={(event) => setEditingInvestment((prev) => ({ ...prev, units: event.target.value }))} />
              </label>
            </div>
            <div className="inline-actions">
              <button onClick={saveEditedInvestment}>Save</button>
              <button className="btn-ghost" onClick={() => setEditingInvestment(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}

      {importPreview.open ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal wide">
            <h3>Import Validation: {importPreview.fileName}</h3>
            <div className="stats-inline">
              <p><strong>Rows:</strong> {importPreview.rows.length}</p>
              <p><strong>Valid:</strong> {importPreview.validation?.validRows?.length || 0}</p>
              <p><strong>Invalid:</strong> {importPreview.validation?.invalidRows?.length || 0}</p>
            </div>

            <label>
              Import mode
              <select
                value={importPreview.mode}
                onChange={(event) => setImportPreview((prev) => ({ ...prev, mode: event.target.value }))}
              >
                <option value="replace">Replace portfolio</option>
                <option value="append">Append to portfolio</option>
              </select>
            </label>

            {(importPreview.validation?.invalidRows?.length || 0) > 0 ? (
              <div className="table-grid table-grid-invalid">
                <div>Row</div><div>Error</div>
                {importPreview.validation.invalidRows.slice(0, 20).map((item) => (
                  <React.Fragment key={`${item.index}-${item.error}`}>
                    <div>{item.index + 1}</div>
                    <div>{item.error}</div>
                  </React.Fragment>
                ))}
              </div>
            ) : <p className="muted">All rows are valid.</p>}

            <div className="inline-actions">
              <button onClick={applyImport} disabled={importBusy}>Apply Import</button>
              <button className="btn-ghost" onClick={() => setImportPreview({ open: false, fileName: '', rows: [], validation: null, mode: 'replace' })}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
