const BINANCE_REST_BASES = [
    "https://data-api.binance.vision/api/v3",
    "https://api.binance.com/api/v3"
];
const BINANCE_WS_BASES = [
    "wss://data-stream.binance.vision/stream?streams=",
    "wss://stream.binance.com:9443/stream?streams="
];

const STORAGE_KEY = "cryptolearn_pro_state_v2";
const INITIAL_BALANCE_MXN = 10000;
const FALLBACK_USDT_MXN = 17.0;

const ASSETS = [
    { id: "bitcoin", name: "Bitcoin", symbol: "BTCUSDT", coin: "BTC", icon: "fab fa-bitcoin", color: "#f59e0b", qty: 0, avgPriceUsdt: 0 },
    { id: "ethereum", name: "Ethereum", symbol: "ETHUSDT", coin: "ETH", icon: "fab fa-ethereum", color: "#3b82f6", qty: 0, avgPriceUsdt: 0 },
    { id: "binancecoin", name: "BNB", symbol: "BNBUSDT", coin: "BNB", icon: "fas fa-coins", color: "#facc15", qty: 0, avgPriceUsdt: 0 },
    { id: "solana", name: "Solana", symbol: "SOLUSDT", coin: "SOL", icon: "fas fa-sun", color: "#10b981", qty: 0, avgPriceUsdt: 0 },
    { id: "cardano", name: "Cardano", symbol: "ADAUSDT", coin: "ADA", icon: "fas fa-chart-line", color: "#2563eb", qty: 0, avgPriceUsdt: 0 },
    { id: "polkadot", name: "Polkadot", symbol: "DOTUSDT", coin: "DOT", icon: "fas fa-bullseye", color: "#ec4899", qty: 0, avgPriceUsdt: 0 },
    { id: "celestia", name: "Celestia", symbol: "TIAUSDT", coin: "TIA", icon: "fas fa-star", color: "#8b5cf6", qty: 0, avgPriceUsdt: 0 }
];

let state = {
    cashMxn: INITIAL_BALANCE_MXN,
    initialBalanceMxn: INITIAL_BALANCE_MXN,
    selectedSymbol: "TIAUSDT",
    selectedInterval: "1m",
    usdtMxn: FALLBACK_USDT_MXN,
    assets: ASSETS.map((asset) => ({ ...asset })),
    transactions: []
};

const market = new Map();
let tickerSocket = null;
let klineSocket = null;
let chartApi = null;
let candleSeries = null;
let candles = [];
let reconnectTickerTimer = null;
let reconnectKlineTimer = null;
let activeRestBase = BINANCE_REST_BASES[0];
let activeWsBase = BINANCE_WS_BASES[0];
let tickerPollTimer = null;
let candlePollTimer = null;
let diagnostics = [];

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.cashMxn === "number") state.cashMxn = parsed.cashMxn;
        if (typeof parsed.initialBalanceMxn === "number") state.initialBalanceMxn = parsed.initialBalanceMxn;
        if (typeof parsed.selectedSymbol === "string") state.selectedSymbol = parsed.selectedSymbol;
        if (typeof parsed.selectedInterval === "string") state.selectedInterval = parsed.selectedInterval;
        if (typeof parsed.usdtMxn === "number") state.usdtMxn = parsed.usdtMxn;
        if (Array.isArray(parsed.transactions)) state.transactions = parsed.transactions.slice(0, 100);

        if (Array.isArray(parsed.assets)) {
            const merged = ASSETS.map((base) => {
                const existing = parsed.assets.find((item) => item.symbol === base.symbol);
                if (!existing) return { ...base };
                return {
                    ...base,
                    qty: Number(existing.qty) || 0,
                    avgPriceUsdt: Number(existing.avgPriceUsdt) || 0
                };
            });
            state.assets = merged;
        }
    } catch (_err) {
        state = {
            ...state,
            assets: ASSETS.map((asset) => ({ ...asset }))
        };
    }

    if (!state.assets.some((asset) => asset.symbol === state.selectedSymbol)) {
        state.selectedSymbol = state.assets[0].symbol;
    }

    if (!["1m", "5m", "15m", "1h"].includes(state.selectedInterval)) {
        state.selectedInterval = "1m";
    }
}

function setConnectionStatus(text, kind = "loading") {
    const badge = document.getElementById("connectionBadge");
    badge.textContent = text;
    badge.classList.remove("connected", "error");
    if (kind === "connected") badge.classList.add("connected");
    if (kind === "error") badge.classList.add("error");
}

function pushDiagnostic(message, level = "info") {
    const now = new Date().toLocaleTimeString("es-MX");
    diagnostics.unshift({ message, level, time: now });
    diagnostics = diagnostics.slice(0, 12);
    renderDiagnostics();
}

function renderDiagnostics() {
    const list = document.getElementById("diagnosticsList");
    if (!list) return;
    if (!diagnostics.length) {
        list.innerHTML = "<li>Sin eventos. Conexion inicializando...</li>";
        return;
    }
    list.innerHTML = diagnostics
        .map((entry) => `<li class="${entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : ""}">[${entry.time}] ${entry.message}</li>`)
        .join("");
}

function canUseCandleSeries() {
    return Boolean(candleSeries && typeof candleSeries.update === "function" && typeof candleSeries.setData === "function");
}

function formatMxn(value) {
    return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 2 }).format(value || 0);
}

function formatUsdt(value) {
    return `${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDT`;
}

function shortNumber(value) {
    const num = Number(value || 0);
    if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
    return num.toFixed(2);
}

function getAsset(symbol) {
    return state.assets.find((asset) => asset.symbol === symbol);
}

async function fetchJson(url, timeoutMs = 9000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
    } catch (error) {
        clearTimeout(timeout);
        if (error.name === "AbortError") {
            throw new Error("Timeout de red");
        }
        throw error;
    }
}

async function fetchBinance(path) {
    let lastError = null;
    for (let i = 0; i < BINANCE_REST_BASES.length; i += 1) {
        const base = BINANCE_REST_BASES[i];
        try {
            const data = await fetchJson(`${base}${path}`);
            activeRestBase = base;
            activeWsBase = BINANCE_WS_BASES[Math.min(i, BINANCE_WS_BASES.length - 1)];
            return data;
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error("No se pudo consultar Binance");
}

async function loadInitialMarket() {
    const symbols = state.assets.map((asset) => asset.symbol);
    const query = encodeURIComponent(JSON.stringify(symbols));

    const [tickers, usdtMxnResp] = await Promise.all([
        fetchBinance(`/ticker/24hr?symbols=${query}`),
        fetchBinance("/ticker/price?symbol=USDTMXN").catch(() => ({ price: FALLBACK_USDT_MXN }))
    ]);

    state.usdtMxn = Number(usdtMxnResp.price) || FALLBACK_USDT_MXN;

    tickers.forEach((ticker) => {
        market.set(ticker.symbol, {
            price: Number(ticker.lastPrice),
            changePct: Number(ticker.priceChangePercent),
            high: Number(ticker.highPrice),
            low: Number(ticker.lowPrice),
            volumeQuote: Number(ticker.quoteVolume)
        });
    });

    saveState();
}

async function refreshTickersViaRest() {
    const symbols = state.assets.map((asset) => asset.symbol);
    const query = encodeURIComponent(JSON.stringify(symbols));
    const tickers = await fetchBinance(`/ticker/24hr?symbols=${query}`);
    tickers.forEach((ticker) => {
        market.set(ticker.symbol, {
            price: Number(ticker.lastPrice),
            changePct: Number(ticker.priceChangePercent),
            high: Number(ticker.highPrice),
            low: Number(ticker.lowPrice),
            volumeQuote: Number(ticker.quoteVolume)
        });
    });
}

function startTickerPolling() {
    if (tickerPollTimer) clearInterval(tickerPollTimer);
    tickerPollTimer = setInterval(async () => {
        try {
            await refreshTickersViaRest();
            renderStats();
            renderMarketCards();
            updatePortfolio();
            updateCoachPanel();
        } catch (_error) {
            // Ignore transient polling errors.
        }
    }, 5000);
}

function startCandlePolling() {
    if (candlePollTimer) clearInterval(candlePollTimer);
    candlePollTimer = setInterval(async () => {
        try {
            const raw = await fetchBinance(`/klines?symbol=${state.selectedSymbol}&interval=${state.selectedInterval}&limit=2`);
            const latest = raw.map((entry) => ({
                time: Math.floor(entry[0] / 1000),
                open: Number(entry[1]),
                high: Number(entry[2]),
                low: Number(entry[3]),
                close: Number(entry[4]),
                volume: Number(entry[5])
            }));

            latest.forEach((candle) => {
                const last = candles[candles.length - 1];
                if (last && last.time === candle.time) candles[candles.length - 1] = candle;
                else candles.push(candle);
                if (canUseCandleSeries()) {
                    candleSeries.update(candle);
                }
            });

            if (candles.length > 350) {
                candles = candles.slice(candles.length - 350);
            }
            updateCoachPanel();
        } catch (_error) {
            // Ignore transient polling errors.
        }
    }, 5000);
}

function connectTickerSocket() {
    const streams = state.assets.map((asset) => `${asset.symbol.toLowerCase()}@ticker`).join("/");
    tickerSocket = new WebSocket(`${activeWsBase}${streams}`);

    tickerSocket.onopen = () => {
        setConnectionStatus("Conectado a Binance (WS)", "connected");
        pushDiagnostic("WebSocket de precios conectado.");
        clearTimeout(reconnectTickerTimer);
    };

    tickerSocket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        const data = payload.data;
        if (!data || !data.s) return;

        market.set(data.s, {
            price: Number(data.c),
            changePct: Number(data.P),
            high: Number(data.h),
            low: Number(data.l),
            volumeQuote: Number(data.q)
        });

        renderStats();
        renderMarketCards();
        updatePortfolio();
        updateCoachPanel();
    };

    tickerSocket.onerror = () => {
        setConnectionStatus("WS inestable, usando REST", "connected");
        pushDiagnostic("WebSocket de precios fallo; seguimos con polling REST.", "warn");
    };

    tickerSocket.onclose = () => {
        setConnectionStatus("Reconectando WS, REST activo", "connected");
        pushDiagnostic("WebSocket de precios cerrado; reintentando.", "warn");
        reconnectTickerTimer = setTimeout(connectTickerSocket, 2500);
    };
}

function intervalToSeconds(interval) {
    if (interval.endsWith("m")) return Number(interval.replace("m", "")) * 60;
    if (interval.endsWith("h")) return Number(interval.replace("h", "")) * 60 * 60;
    return 60;
}

async function loadCandles(symbol, interval) {
    const raw = await fetchBinance(`/klines?symbol=${symbol}&interval=${interval}&limit=300`);
    candles = raw.map((entry) => ({
        time: Math.floor(entry[0] / 1000),
        open: Number(entry[1]),
        high: Number(entry[2]),
        low: Number(entry[3]),
        close: Number(entry[4]),
        volume: Number(entry[5])
    }));
    if (canUseCandleSeries()) {
        candleSeries.setData(candles);
    } else {
        pushDiagnostic("Serie de velas no lista aun; esperando inicializacion de grafico.", "warn");
        return;
    }
    if (chartApi?.timeScale) {
        chartApi.timeScale().fitContent();
    }
    updateCoachPanel();
}

function connectKlineSocket() {
    if (klineSocket) {
        klineSocket.close();
        klineSocket = null;
    }

    if (!canUseCandleSeries()) {
        pushDiagnostic("Grafico aun no listo para WebSocket de velas; se omite conexion temporal.", "warn");
        return;
    }

    const stream = `${state.selectedSymbol.toLowerCase()}@kline_${state.selectedInterval}`;
    klineSocket = new WebSocket(`${activeWsBase}${stream}`);

    klineSocket.onopen = () => {
        clearTimeout(reconnectKlineTimer);
    };

    klineSocket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        const kline = payload?.data?.k;
        if (!kline) return;

        const candle = {
            time: Math.floor(kline.t / 1000),
            open: Number(kline.o),
            high: Number(kline.h),
            low: Number(kline.l),
            close: Number(kline.c),
            volume: Number(kline.v)
        };

        const last = candles[candles.length - 1];
        if (last && last.time === candle.time) {
            candles[candles.length - 1] = candle;
        } else {
            candles.push(candle);
            if (candles.length > 350) candles.shift();
        }

        if (!canUseCandleSeries()) {
            return;
        }
        candleSeries.update(candle);
        updateCoachPanel();
    };

    klineSocket.onclose = () => {
        pushDiagnostic("WebSocket de velas cerrado; reintentando.", "warn");
        reconnectKlineTimer = setTimeout(async () => {
            await loadCandles(state.selectedSymbol, state.selectedInterval).catch(() => {});
            connectKlineSocket();
        }, 1800);
    };
}

function buildChart() {
    const container = document.getElementById("chartContainer");
    chartApi = LightweightCharts.createChart(container, {
        layout: {
            background: { color: "#ffffff" },
            textColor: "#334155"
        },
        grid: {
            vertLines: { color: "#f1f5f9" },
            horzLines: { color: "#f1f5f9" }
        },
        rightPriceScale: {
            borderColor: "#e2e8f0"
        },
        timeScale: {
            borderColor: "#e2e8f0"
        },
        crosshair: {
            mode: 1
        }
    });

    const seriesOptions = {
        upColor: "#16a34a",
        downColor: "#dc2626",
        borderVisible: false,
        wickUpColor: "#16a34a",
        wickDownColor: "#dc2626"
    };

    // Compatibilidad: lightweight-charts v4 (addCandlestickSeries) y v5 (addSeries).
    if (typeof chartApi.addCandlestickSeries === "function") {
        candleSeries = chartApi.addCandlestickSeries(seriesOptions);
    } else if (typeof chartApi.addSeries === "function" && LightweightCharts.CandlestickSeries) {
        candleSeries = chartApi.addSeries(LightweightCharts.CandlestickSeries, seriesOptions);
    } else {
        throw new Error("API de lightweight-charts no compatible para velas.");
    }

    if (!canUseCandleSeries()) {
        throw new Error("No se pudo inicializar la serie de velas.");
    }

    const onResize = () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        chartApi.applyOptions({ width, height });
    };

    window.addEventListener("resize", onResize);
    onResize();
}

function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let i = period; i < values.length; i += 1) {
        current = values[i] * k + current * (1 - k);
    }
    return current;
}

function rsi(values, period = 14) {
    if (values.length <= period) return null;
    let gains = 0;
    let losses = 0;

    for (let i = values.length - period; i < values.length; i += 1) {
        const diff = values[i] - values[i - 1];
        if (diff >= 0) gains += diff;
        else losses += Math.abs(diff);
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
}

function updateCoachPanel() {
    const summaryEl = document.getElementById("coachSummary");
    const listEl = document.getElementById("coachList");

    const selectedAsset = getAsset(state.selectedSymbol);
    const selectedMarket = market.get(state.selectedSymbol);

    if (!selectedAsset || !selectedMarket || candles.length < 30) {
        summaryEl.textContent = "Cargando contexto del mercado para darte una lectura educativa...";
        listEl.innerHTML = "";
        return;
    }

    const closes = candles.map((candle) => candle.close);
    const volumes = candles.map((candle) => candle.volume);
    const lastClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2] || lastClose;

    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const rsi14 = rsi(closes, 14);

    const lastVolume = volumes[volumes.length - 1];
    const avgVolume = volumes.slice(-20).reduce((sum, value) => sum + value, 0) / Math.min(20, volumes.length);

    const insights = [];

    if (ema9 && ema21) {
        if (ema9 > ema21) insights.push(`Tendencia corta alcista: EMA9 (${ema9.toFixed(4)}) arriba de EMA21 (${ema21.toFixed(4)}).`);
        else insights.push(`Tendencia corta bajista: EMA9 (${ema9.toFixed(4)}) debajo de EMA21 (${ema21.toFixed(4)}).`);
    }

    if (typeof rsi14 === "number") {
        if (rsi14 > 70) insights.push(`RSI ${rsi14.toFixed(1)}: zona de sobrecompra, posible enfriamiento.`);
        else if (rsi14 < 30) insights.push(`RSI ${rsi14.toFixed(1)}: zona de sobreventa, posible rebote.`);
        else insights.push(`RSI ${rsi14.toFixed(1)}: momentum neutral.`);
    }

    if (lastVolume > avgVolume * 1.8) insights.push(`Volumen por vela alto (${(lastVolume / avgVolume).toFixed(2)}x del promedio). Hay fuerza en el movimiento.`);
    else insights.push("Volumen normal, el movimiento aun no muestra aceleracion fuerte.");

    const intrabarMove = ((lastClose - prevClose) / prevClose) * 100;
    insights.push(`Ultima vela: ${intrabarMove >= 0 ? "+" : ""}${intrabarMove.toFixed(2)}%. Cambio 24h: ${selectedMarket.changePct.toFixed(2)}%.`);

    if (selectedAsset.qty > 0) {
        const unrealizedPct = ((lastClose - selectedAsset.avgPriceUsdt) / selectedAsset.avgPriceUsdt) * 100;
        insights.push(`Tu posicion en ${selectedAsset.coin} va ${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(2)}% vs tu precio promedio.`);
    } else {
        insights.push(`Aun no tienes ${selectedAsset.coin}. Puedes probar entradas pequenas para practicar gestion de riesgo.`);
    }

    summaryEl.textContent = `${selectedAsset.coin} en ${state.selectedInterval} | Precio ${selectedMarket.price.toFixed(4)} USDT`;
    listEl.innerHTML = insights.map((item) => `<li>${item}</li>`).join("");
}

function updatePortfolio() {
    let cryptoValueMxn = 0;

    state.assets.forEach((asset) => {
        const ticker = market.get(asset.symbol);
        if (!ticker) return;
        cryptoValueMxn += asset.qty * ticker.price * state.usdtMxn;
    });

    const total = state.cashMxn + cryptoValueMxn;
    const pnl = total - state.initialBalanceMxn;

    document.getElementById("availableBalance").textContent = formatMxn(state.cashMxn);
    document.getElementById("cryptoValue").textContent = formatMxn(cryptoValueMxn);
    document.getElementById("totalValue").textContent = formatMxn(total);

    const pnlEl = document.getElementById("pnl");
    pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${formatMxn(pnl)}`;
    pnlEl.className = `portfolio-value ${pnl >= 0 ? "positive" : "negative"}`;
}

function renderStats() {
    const selected = getAsset(state.selectedSymbol);
    const ticker = market.get(state.selectedSymbol);
    if (!selected || !ticker) return;

    document.getElementById("selectedSymbol").textContent = selected.symbol;
    document.getElementById("selectedName").textContent = selected.name;
    document.getElementById("selectedPrice").textContent = ticker.price.toFixed(6);
    document.getElementById("selectedChange").textContent = `${ticker.changePct >= 0 ? "+" : ""}${ticker.changePct.toFixed(2)}% (24h)`;
    document.getElementById("selectedChange").className = `stat-change ${ticker.changePct >= 0 ? "positive" : "negative"}`;

    document.getElementById("selectedVolume").textContent = shortNumber(ticker.volumeQuote);
    document.getElementById("selectedRange").textContent = `Rango 24h: ${ticker.low.toFixed(4)} - ${ticker.high.toFixed(4)}`;
    document.getElementById("usdtMxnRate").textContent = state.usdtMxn.toFixed(4);
}

function buildAssetSelector() {
    const assetSelector = document.getElementById("assetSelector");
    const intervalSelector = document.getElementById("intervalSelector");

    assetSelector.innerHTML = state.assets
        .map((asset) => `<option value="${asset.symbol}">${asset.coin} (${asset.symbol})</option>`)
        .join("");

    assetSelector.value = state.selectedSymbol;
    intervalSelector.value = state.selectedInterval;

    assetSelector.addEventListener("change", async (event) => {
        state.selectedSymbol = event.target.value;
        saveState();
        renderStats();
        updateCoachPanel();
        await loadCandles(state.selectedSymbol, state.selectedInterval).catch(() => {
            showNotification("No se pudieron cargar velas para ese activo", "error");
        });
        connectKlineSocket();
        startCandlePolling();
    });

    intervalSelector.addEventListener("change", async (event) => {
        state.selectedInterval = event.target.value;
        saveState();
        await loadCandles(state.selectedSymbol, state.selectedInterval).catch(() => {
            showNotification("No se pudieron cargar velas para ese intervalo", "error");
        });
        connectKlineSocket();
        startCandlePolling();
    });
}

function renderMarketCards() {
    const grid = document.getElementById("cryptoGrid");
    grid.innerHTML = "";

    state.assets.forEach((asset) => {
        const ticker = market.get(asset.symbol);
        const price = ticker?.price || 0;
        const change = ticker?.changePct || 0;
        const holdingValueMxn = asset.qty * price * state.usdtMxn;

        const card = document.createElement("div");
        card.className = "crypto-card";
        card.innerHTML = `
            <div class="crypto-header">
                <div class="crypto-icon" style="background:${asset.color}"><i class="${asset.icon}"></i></div>
                <div>
                    <div class="crypto-name">${asset.name}</div>
                    <div class="crypto-symbol">${asset.symbol}</div>
                </div>
            </div>
            <div class="crypto-price">${price ? formatUsdt(price) : "Cargando..."}</div>
            <div class="crypto-symbol ${change >= 0 ? "positive" : "negative"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}% (24h)</div>
            <div class="crypto-symbol">Posicion: ${asset.qty.toFixed(6)} ${asset.coin}</div>
            <div class="crypto-symbol">Promedio: ${asset.avgPriceUsdt ? asset.avgPriceUsdt.toFixed(6) : "-"} USDT</div>
            <div class="crypto-symbol">Valor MXN: ${formatMxn(holdingValueMxn)}</div>
            <div class="trade-controls">
                <input type="number" min="0" step="0.0001" placeholder="Cantidad" id="qty-${asset.symbol}">
                <button class="btn btn-buy" data-action="buy" data-symbol="${asset.symbol}">Comprar</button>
                <button class="btn btn-sell" data-action="sell" data-symbol="${asset.symbol}" ${asset.qty <= 0 ? "disabled" : ""}>Vender</button>
            </div>
        `;

        grid.appendChild(card);
    });
}

function renderTransactions() {
    const body = document.getElementById("transactionsBody");
    const recent = state.transactions.slice(0, 25);

    if (!recent.length) {
        body.innerHTML = '<tr><td class="empty-row" colspan="7">Sin operaciones aun</td></tr>';
        return;
    }

    body.innerHTML = recent
        .map((tx) => {
            const date = new Date(tx.date).toLocaleString("es-MX");
            return `
                <tr>
                    <td>${date}</td>
                    <td class="${tx.type === "COMPRA" ? "positive" : "negative"}">${tx.type}</td>
                    <td>${tx.symbol}</td>
                    <td>${tx.qty.toFixed(6)}</td>
                    <td>${tx.priceUsdt.toFixed(6)}</td>
                    <td>${formatMxn(tx.totalMxn)}</td>
                    <td>${tx.note || "-"}</td>
                </tr>
            `;
        })
        .join("");
}

function registerTransaction(tx) {
    state.transactions.unshift(tx);
    state.transactions = state.transactions.slice(0, 100);
    saveState();
    renderTransactions();
}

function parseQtyInput(symbol) {
    const input = document.getElementById(`qty-${symbol}`);
    const qty = Number(input?.value);
    if (!qty || qty <= 0) return null;
    return qty;
}

function buyAsset(symbol) {
    const asset = getAsset(symbol);
    const ticker = market.get(symbol);
    if (!asset || !ticker) {
        showNotification("Aun no hay precio en vivo para este activo", "error");
        return;
    }

    const qty = parseQtyInput(symbol);
    if (!qty) {
        showNotification("Ingresa una cantidad valida", "error");
        return;
    }

    const totalUsdt = qty * ticker.price;
    const totalMxn = totalUsdt * state.usdtMxn;

    if (totalMxn > state.cashMxn) {
        showNotification("Saldo virtual insuficiente", "error");
        return;
    }

    const costBefore = asset.qty * asset.avgPriceUsdt;
    asset.qty += qty;
    asset.avgPriceUsdt = (costBefore + totalUsdt) / asset.qty;
    state.cashMxn -= totalMxn;

    registerTransaction({
        date: new Date().toISOString(),
        type: "COMPRA",
        symbol,
        qty,
        priceUsdt: ticker.price,
        totalMxn,
        note: "Entrada simulada"
    });

    saveState();
    renderMarketCards();
    updatePortfolio();
    updateCoachPanel();
    showNotification(`Compra simulada: ${qty} ${asset.coin}`);
}

function sellAsset(symbol) {
    const asset = getAsset(symbol);
    const ticker = market.get(symbol);
    if (!asset || !ticker) {
        showNotification("Aun no hay precio en vivo para este activo", "error");
        return;
    }

    const qty = parseQtyInput(symbol);
    if (!qty) {
        showNotification("Ingresa una cantidad valida", "error");
        return;
    }

    if (qty > asset.qty) {
        showNotification("No tienes esa cantidad para vender", "error");
        return;
    }

    const totalUsdt = qty * ticker.price;
    const totalMxn = totalUsdt * state.usdtMxn;
    const pnlPct = ((ticker.price - asset.avgPriceUsdt) / asset.avgPriceUsdt) * 100;

    asset.qty -= qty;
    if (asset.qty <= 0) {
        asset.qty = 0;
        asset.avgPriceUsdt = 0;
    }

    state.cashMxn += totalMxn;

    registerTransaction({
        date: new Date().toISOString(),
        type: "VENTA",
        symbol,
        qty,
        priceUsdt: ticker.price,
        totalMxn,
        note: `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% vs promedio`
    });

    saveState();
    renderMarketCards();
    updatePortfolio();
    updateCoachPanel();
    showNotification(`Venta simulada: ${qty} ${asset.coin}`);
}

function wireActions() {
    document.getElementById("cryptoGrid").addEventListener("click", (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;

        const action = button.dataset.action;
        const symbol = button.dataset.symbol;

        if (action === "buy") buyAsset(symbol);
        if (action === "sell") sellAsset(symbol);
    });

    document.getElementById("addFundsBtn").addEventListener("click", () => {
        state.cashMxn += 1000;
        saveState();
        updatePortfolio();
        showNotification("Se agregaron $1,000 MXN virtuales");
    });

    document.getElementById("resetPortfolioBtn").addEventListener("click", () => {
        if (!window.confirm("Se borraran posiciones y operaciones simuladas. Continuar?")) return;

        state.cashMxn = INITIAL_BALANCE_MXN;
        state.initialBalanceMxn = INITIAL_BALANCE_MXN;
        state.assets = ASSETS.map((asset) => ({ ...asset }));
        state.transactions = [];
        saveState();
        renderMarketCards();
        renderTransactions();
        updatePortfolio();
        updateCoachPanel();
        showNotification("Simulador reiniciado");
    });
}

function showNotification(message, type = "ok") {
    const toast = document.createElement("div");
    toast.className = `notification ${type === "error" ? "error" : ""}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 2600);
}

async function initialize() {
    setConnectionStatus("Cargando mercado...");
    renderDiagnostics();
    loadState();
    buildAssetSelector();
    buildChart();
    wireActions();
    renderTransactions();

    try {
        await loadInitialMarket();
        setConnectionStatus("Conectado por REST", "connected");
        pushDiagnostic(`Conexion REST OK (${activeRestBase}).`);
        renderStats();
        renderMarketCards();
        updatePortfolio();

        await loadCandles(state.selectedSymbol, state.selectedInterval);
        startTickerPolling();
        startCandlePolling();
        connectTickerSocket();
        connectKlineSocket();
    } catch (error) {
        setConnectionStatus("No se pudo conectar a Binance", "error");
        renderMarketCards();
        updatePortfolio();
        showNotification("Fallo la conexion inicial con Binance. Revisa tu red o region.", "error");
        pushDiagnostic(`Fallo inicial: ${error.message || error}`, "error");
        console.error(error);
    }
}

window.onerror = (msg, url, line, col, error) => {
    pushDiagnostic(`JS error: ${msg} (linea ${line})`, "error");
    console.error("window.onerror", { msg, url, line, col, error });
    return false;
};

window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason?.message || String(event.reason);
    pushDiagnostic(`Promesa rechazada: ${reason}`, "error");
    console.error("unhandledrejection", event.reason);
});

window.addEventListener("DOMContentLoaded", initialize);
