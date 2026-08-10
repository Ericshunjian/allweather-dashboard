(() => {
  "use strict";

  const AUTH = window.PORTFOLIO_VAULT_AUTH;
  const STORAGE_KEY = "allweather.portfolio.vault.v1";
  const VAULT_AAD = "allweather-portfolio-vault-data-v1";
  const AUTH_PLAINTEXT = "allweather-portfolio-vault-unlocked-v1";
  const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const commonUsQuotes = Object.freeze({ SPY: "usSPY", QQQ: "usQQQ" });
  const tencentQuoteEndpoint = "https://qt.gtimg.cn/q=";
  const sinaFuturesEndpoint = "https://stock.finance.sina.com.cn/futures/api/jsonp.php";
  const typeLabels = Object.freeze({
    stock: "股票",
    etf: "ETF",
    fund: "场外基金",
    gold: "黄金",
    bond: "债券",
    wealth: "银行理财",
    deposit: "存款",
    cash: "现金",
    futures: "期货",
    option: "期权",
    other: "其他"
  });
  const bucketLabels = Object.freeze({
    gold: "黄金",
    dividend: "红利低波",
    a500: "宽基权益",
    bond_futures: "国债期货",
    cash: "现金理财",
    other: "其他"
  });
  const classLabels = Object.freeze({
    equity: "权益",
    bond: "债券",
    gold: "黄金",
    cash: "现金理财",
    other: "其他"
  });

  let sessionKey = null;
  let vault = null;
  let strategyTarget = null;
  let activeFilter = "all";
  let pendingDeleteId = null;
  let lockTimer = null;
  let toastTimer = null;

  const $ = (id) => document.getElementById(id);
  const lockScreen = $("lock-screen");
  const app = $("vault-app");
  const unlockForm = $("unlock-form");
  const passwordInput = $("vault-password");
  const unlockButton = $("unlock-button");
  const unlockError = $("unlock-error");
  const holdingDialog = $("holding-dialog");
  const holdingForm = $("holding-form");
  const confirmDialog = $("confirm-dialog");

  function bytesFromBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function base64FromBytes(value) {
    let binary = "";
    const bytes = new Uint8Array(value);
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  async function deriveKey(password) {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: bytesFromBase64(AUTH.salt),
        iterations: Number(AUTH.iterations)
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function verifyKey(key) {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesFromBase64(AUTH.iv),
        additionalData: encoder.encode(AUTH.aad)
      },
      key,
      bytesFromBase64(AUTH.ciphertext)
    );
    return decoder.decode(plaintext) === AUTH_PLAINTEXT;
  }

  async function encryptVault(data) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: encoder.encode(VAULT_AAD)
      },
      sessionKey,
      plaintext
    );
    return JSON.stringify({
      version: 1,
      iv: base64FromBytes(iv),
      ciphertext: base64FromBytes(ciphertext)
    });
  }

  async function decryptVault(raw) {
    const bundle = JSON.parse(raw);
    if (bundle.version !== 1 || !bundle.iv || !bundle.ciphertext) {
      throw new Error("不支持的加密数据格式");
    }
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesFromBase64(bundle.iv),
        additionalData: encoder.encode(VAULT_AAD)
      },
      sessionKey,
      bytesFromBase64(bundle.ciphertext)
    );
    const parsed = JSON.parse(decoder.decode(plaintext));
    validateVault(parsed);
    return parsed;
  }

  function validateVault(candidate) {
    if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.holdings)) {
      throw new Error("资产备份格式无效");
    }
    if (!Array.isArray(candidate.snapshots)) {
      candidate.snapshots = [];
    }
  }

  function createEmptyVault() {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      holdings: [],
      snapshots: [],
      fxRates: { CNY: 1, USD: null, HKD: null, updatedAt: null }
    };
  }

  async function persistVault() {
    if (!sessionKey || !vault) return;
    vault.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, await encryptVault(vault));
  }

  async function loadVault() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      vault = createEmptyVault();
      await persistVault();
      return;
    }
    vault = await decryptVault(stored);
  }

  function resetLockTimer() {
    if (!sessionKey) return;
    clearTimeout(lockTimer);
    lockTimer = setTimeout(lockVault, SESSION_TIMEOUT_MS);
  }

  function lockVault() {
    clearTimeout(lockTimer);
    sessionKey = null;
    vault = null;
    app.hidden = true;
    lockScreen.hidden = false;
    passwordInput.value = "";
    passwordInput.type = "password";
    $("toggle-password").textContent = "显示";
    $("toggle-password").setAttribute("aria-label", "显示密码");
    passwordInput.focus();
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
  }

  function chinaDate() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.year}-${map.month}-${map.day}`;
  }

  function formatMoney(value, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    const absolute = Math.abs(number);
    const formatted = new Intl.NumberFormat("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(absolute);
    return `${number < 0 ? "-" : ""}¥${formatted}`;
  }

  function formatNative(value, currency) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: currency || "CNY",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(number);
  }

  function formatPercent(value, digits = 1) {
    return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(digits)}%` : "--";
  }

  function formatNumber(value, digits = 2) {
    return Number.isFinite(Number(value))
      ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(Number(value))
      : "--";
  }

  function numeric(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function assetClass(item) {
    if (item.strategyBucket === "gold" || item.assetType === "gold") return "gold";
    if (item.strategyBucket === "bond_futures" || item.assetType === "bond" || item.assetType === "futures") return "bond";
    if (item.strategyBucket === "cash" || ["cash", "wealth", "deposit"].includes(item.assetType)) return "cash";
    if (["a500", "dividend"].includes(item.strategyBucket) || ["stock", "etf", "fund"].includes(item.assetType)) return "equity";
    return "other";
  }

  function accruedFixedValue(item) {
    const principal = numeric(item.fixedValue);
    if (item.pricingMode !== "interest" || !item.valuationDate) return principal;
    const base = new Date(`${item.valuationDate}T00:00:00+08:00`);
    const now = new Date();
    const days = Math.max(0, (now - base) / 86400000);
    return principal * (1 + numeric(item.annualRate) * days / 365);
  }

  function calculateHolding(item) {
    const fx = item.currency === "CNY" ? 1 : numeric(vault.fxRates?.[item.currency], NaN);
    const quantity = numeric(item.quantity);
    const price = numeric(item.price);
    const previousClose = numeric(item.previousClose, price);
    const entry = numeric(item.entryPrice, price);
    const multiplier = Math.max(numeric(item.multiplier, 1), 0);
    const direction = numeric(item.direction, 1) < 0 ? -1 : 1;
    const derivative = item.assetType === "futures" || item.assetType === "option";
    let nativeValue = 0;
    let nativeExposure = 0;
    let nativePnl = 0;
    let nativeDailyPnl = 0;

    if (["fixed", "interest"].includes(item.pricingMode)) {
      nativeValue = accruedFixedValue(item);
      const dailyRate = numeric(item.annualRate) / 365;
      nativeDailyPnl = item.pricingMode === "interest" ? nativeValue * dailyRate : 0;
      nativePnl = nativeValue - numeric(item.fixedValue);
      nativeExposure = item.strategyBucket === "cash" ? 0 : nativeValue;
    } else if (item.assetType === "futures") {
      nativeExposure = direction * quantity * price * multiplier;
      nativePnl = direction * quantity * (price - entry) * multiplier;
      nativeDailyPnl = direction * quantity * (price - previousClose) * multiplier;
      nativeValue = item.includeNav ? nativePnl : 0;
    } else if (item.assetType === "option") {
      const optionDelta = numeric(item.delta);
      const underlyingPrice = numeric(item.underlyingPrice);
      nativeExposure = direction * optionDelta * quantity * underlyingPrice * multiplier;
      nativePnl = direction * quantity * (price - entry) * multiplier;
      nativeDailyPnl = direction * quantity * (price - previousClose) * multiplier;
      nativeValue = item.includeNav ? direction * quantity * price * multiplier : 0;
    } else {
      nativeValue = quantity * price * multiplier;
      nativeExposure = item.strategyBucket === "cash" ? 0 : nativeValue;
      nativePnl = quantity * (price - entry) * multiplier;
      nativeDailyPnl = quantity * (price - previousClose) * multiplier;
    }

    const validFx = Number.isFinite(fx) && fx > 0;
    return {
      nativeValue,
      nativeExposure,
      nativePnl,
      nativeDailyPnl,
      valueCny: item.includeNav && validFx ? nativeValue * fx : 0,
      exposureCny: validFx ? nativeExposure * fx : 0,
      pnlCny: validFx ? nativePnl * fx : 0,
      dailyPnlCny: validFx ? nativeDailyPnl * fx : 0,
      fx,
      validFx,
      derivative
    };
  }

  function portfolioMetrics() {
    const rows = vault.holdings.map((item) => ({ item, calc: calculateHolding(item) }));
    const totalAssets = rows.reduce((sum, row) => sum + row.calc.valueCny, 0);
    const dailyPnl = rows.reduce((sum, row) => sum + row.calc.dailyPnlCny, 0);
    const grossExposure = rows.reduce((sum, row) => sum + Math.abs(row.calc.exposureCny), 0);
    const includedCount = rows.filter((row) => row.item.includeNav).length;
    const derivativeCount = rows.filter((row) => row.calc.derivative).length;
    return { rows, totalAssets, dailyPnl, grossExposure, includedCount, derivativeCount };
  }

  function inferQuoteId(item) {
    const explicit = String(item.quoteId || "").trim();
    if (explicit) {
      if (/^(?:tencent|sina):/i.test(explicit)) return explicit;
      return `tencent:${explicit}`;
    }
    let code = String(item.code || "").trim().toUpperCase();
    if (!code) return "";
    if (item.assetType === "futures") {
      let futuresCode = code.replace(/\.CFE$/i, "");
      if (/^(?:T|TF|TS|TL)$/.test(futuresCode)) futuresCode += "0";
      return `sina:${futuresCode}`;
    }
    if (item.assetType === "option") return "";
    if (item.assetType === "fund" && /^\d{6}$/.test(code)) return `tencent:jj${code}`;
    if (commonUsQuotes[code]) return `tencent:${commonUsQuotes[code]}`;
    if (/^[A-Z][A-Z0-9.-]{0,14}$/.test(code)) return `tencent:us${code}`;
    if (code.endsWith(".HK")) code = code.slice(0, -3).padStart(5, "0");
    if (/^\d{5}$/.test(code)) return `tencent:hk${code}`;
    if (/^\d{6}$/.test(code)) return `tencent:${/^[5689]/.test(code) ? "sh" : "sz"}${code}`;
    return "";
  }

  function parseTencentTimestamp(value) {
    const text = String(value || "").trim();
    const compact = text.replace(/\D/g, "");
    if (compact.length >= 14) {
      const date = new Date(
        Number(compact.slice(0, 4)),
        Number(compact.slice(4, 6)) - 1,
        Number(compact.slice(6, 8)),
        Number(compact.slice(8, 10)),
        Number(compact.slice(10, 12)),
        Number(compact.slice(12, 14))
      );
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    const parsed = new Date(text.replace(/\//g, "-"));
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }

  async function fetchTencentQuote(symbol) {
    const url = `${tencentQuoteEndpoint}${encodeURIComponent(symbol)}&_=${Date.now()}`;
    const response = await fetch(url, { cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.text();
    const firstQuote = payload.indexOf('"');
    const lastQuote = payload.lastIndexOf('"');
    if (firstQuote < 0 || lastQuote <= firstQuote) throw new Error("无有效行情");
    const fields = payload.slice(firstQuote + 1, lastQuote).split("~");
    const isFund = symbol.toLowerCase().startsWith("jj");
    const isForex = symbol.toLowerCase().startsWith("wh");
    const price = numeric(isFund ? fields[5] : fields[3], NaN);
    const previousClose = numeric(isFund ? fields[5] : (isForex ? fields[6] : fields[4]), price);
    const timeValue = isFund ? fields[8] : (isForex ? fields[5] : fields[30]);
    if (!Number.isFinite(price) || price <= 0) throw new Error("无有效收盘价");
    return {
      price,
      previousClose: Number.isFinite(previousClose) && previousClose > 0 ? previousClose : price,
      name: String(fields[1] || fields[2] || symbol),
      quoteTime: parseTencentTimestamp(timeValue)
    };
  }

  function fetchSinaFuturesQuote(symbol) {
    return new Promise((resolve, reject) => {
      const callbackName = `__portfolioVaultQuote_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const cleanup = () => {
        delete window[callbackName];
        script.remove();
      };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("期货行情超时"));
      }, 12000);
      window[callbackName] = (rows) => {
        window.clearTimeout(timer);
        cleanup();
        const observations = Array.isArray(rows) ? rows.filter((row) => row && row.d && row.c) : [];
        const latest = observations.at(-1);
        const previous = observations.at(-2);
        const price = numeric(latest?.c, NaN);
        if (!Number.isFinite(price) || price <= 0) {
          reject(new Error("无有效期货收盘价"));
          return;
        }
        resolve({
          price,
          previousClose: numeric(previous?.c, price),
          name: symbol.toUpperCase(),
          quoteTime: parseTencentTimestamp(latest.d)
        });
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        cleanup();
        reject(new Error("期货行情加载失败"));
      };
      script.src = `${sinaFuturesEndpoint}/${callbackName}/InnerFuturesNewService.getDailyKLine?symbol=${encodeURIComponent(symbol)}&_=${Date.now()}`;
      script.referrerPolicy = "no-referrer";
      document.head.appendChild(script);
    });
  }

  async function fetchQuote(quoteId) {
    const separator = quoteId.indexOf(":");
    const provider = separator > 0 ? quoteId.slice(0, separator).toLowerCase() : "tencent";
    const symbol = separator > 0 ? quoteId.slice(separator + 1) : quoteId;
    if (provider === "sina") return fetchSinaFuturesQuote(symbol);
    return fetchTencentQuote(symbol);
  }

  async function loadStrategyTarget() {
    try {
      const response = await fetch(`strategy-target.json?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      strategyTarget = await response.json();
    } catch (error) {
      strategyTarget = null;
    }
  }

  async function refreshQuotes(options = {}) {
    if (!vault) return;
    const button = $("refresh-quotes");
    button.disabled = true;
    button.textContent = "刷新中";
    let success = 0;
    let attempted = 0;

    const fxRequests = [
      ["USD", "tencent:whUSDCNY"],
      ["HKD", "tencent:whHKDCNY"]
    ];
    await Promise.all(fxRequests.map(async ([currency, quoteId]) => {
      try {
        const quote = await fetchQuote(quoteId);
        vault.fxRates[currency] = quote.price;
        vault.fxRates.updatedAt = quote.quoteTime;
      } catch (error) {
        // Retain the last encrypted FX observation when the endpoint is unavailable.
      }
    }));

    await Promise.all(vault.holdings.map(async (item) => {
      if (item.pricingMode !== "auto") return;
      const quoteId = inferQuoteId(item);
      attempted += 1;
      if (!quoteId) {
        item.quoteStatus = "需填写行情标识";
        return;
      }
      try {
        const quote = await fetchQuote(quoteId);
        item.price = quote.price;
        item.previousClose = quote.previousClose;
        item.quoteName = quote.name;
        item.quoteTime = quote.quoteTime;
        item.quoteStatus = "已更新";
        success += 1;
      } catch (error) {
        item.quoteStatus = "行情暂不可用";
      }
    }));

    await persistVault();
    renderAll();
    await recordSnapshot();
    button.disabled = false;
    button.textContent = "刷新行情";
    if (!options.silent) showToast(`行情更新完成：${success}/${attempted}`);
  }

  async function recordSnapshot() {
    const metrics = portfolioMetrics();
    if (!(metrics.totalAssets > 0)) return;
    const date = chinaDate();
    const snapshot = {
      date,
      totalAssets: metrics.totalAssets,
      dailyPnl: metrics.dailyPnl,
      grossExposure: metrics.grossExposure
    };
    const existingIndex = vault.snapshots.findIndex((item) => item.date === date);
    if (existingIndex >= 0) vault.snapshots[existingIndex] = snapshot;
    else vault.snapshots.push(snapshot);
    vault.snapshots = vault.snapshots
      .filter((item) => item && item.date && Number.isFinite(Number(item.totalAssets)))
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-750);
    await persistVault();
    renderHistory();
  }

  function setSignedClass(element, value) {
    element.classList.remove("positive", "negative");
    if (value > 0) element.classList.add("positive");
    if (value < 0) element.classList.add("negative");
  }

  function renderSummary(metrics) {
    $("total-assets").textContent = formatMoney(metrics.totalAssets);
    $("daily-pnl").textContent = formatMoney(metrics.dailyPnl);
    setSignedClass($("daily-pnl"), metrics.dailyPnl);
    $("gross-exposure").textContent = metrics.totalAssets > 0
      ? `${(metrics.grossExposure / metrics.totalAssets).toFixed(2)}x`
      : "0.00x";
    $("included-count").textContent = `${metrics.includedCount}项计入净资产`;
    $("derivative-count").textContent = `${metrics.derivativeCount}项衍生品`;
    const automatic = vault.holdings.filter((item) => item.pricingMode === "auto");
    const covered = automatic.filter((item) => item.quoteStatus === "已更新").length;
    $("quote-coverage").textContent = `行情覆盖 ${covered}/${automatic.length}`;
    const latestTimes = vault.holdings.map((item) => item.quoteTime).filter(Boolean).sort();
    $("valuation-time").textContent = latestTimes.length
      ? `最近行情 ${new Date(latestTimes.at(-1)).toLocaleString("zh-CN", { hour12: false })}`
      : `台账更新 ${new Date(vault.updatedAt).toLocaleString("zh-CN", { hour12: false })}`;
  }

  function createBarRow(label, value, maxValue, target = null, valueLabel = null) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const labelNode = document.createElement("span");
    labelNode.className = "bar-label";
    labelNode.textContent = label;
    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = `${Math.min(100, Math.abs(value) / Math.max(maxValue, 1e-12) * 100)}%`;
    track.appendChild(fill);
    if (target !== null) {
      const targetBar = document.createElement("span");
      targetBar.className = "bar-target";
      targetBar.style.width = `${Math.min(100, Math.abs(target) / Math.max(maxValue, 1e-12) * 100)}%`;
      track.appendChild(targetBar);
    }
    const valueNode = document.createElement("span");
    valueNode.className = "bar-value";
    valueNode.textContent = valueLabel || formatPercent(value);
    row.append(labelNode, track, valueNode);
    return row;
  }

  function renderAllocation(metrics) {
    const container = $("allocation-bars");
    container.replaceChildren();
    if (!(metrics.totalAssets > 0)) {
      const empty = document.createElement("div");
      empty.className = "bar-empty";
      empty.textContent = "录入资产后显示构成";
      container.appendChild(empty);
      return;
    }
    const totals = { equity: 0, bond: 0, gold: 0, cash: 0, other: 0 };
    metrics.rows.forEach(({ item, calc }) => {
      if (item.includeNav) totals[assetClass(item)] += calc.valueCny;
    });
    Object.entries(totals)
      .filter(([, value]) => Math.abs(value) > 0.01)
      .sort((left, right) => right[1] - left[1])
      .forEach(([key, value]) => {
        container.appendChild(createBarRow(classLabels[key], value / metrics.totalAssets, 1, null, `${formatPercent(value / metrics.totalAssets)} · ${formatMoney(value)}`));
      });
  }

  function targetBuckets() {
    if (!strategyTarget?.latest_scaled_weights) return null;
    const weights = strategyTarget.latest_scaled_weights;
    const marginRate = numeric(strategyTarget.futures_margin_rate, 0.02);
    const targets = {
      gold: numeric(weights["518880.SH"]),
      dividend: numeric(weights["921446.CSI"]),
      a500: numeric(weights["000510CNY010"]),
      bond_futures: numeric(weights["T.CFE"])
    };
    targets.cash = Math.max(0, 1 - targets.gold - targets.dividend - targets.a500 - Math.abs(targets.bond_futures) * marginRate);
    return targets;
  }

  function renderStrategy(metrics) {
    const container = $("strategy-bars");
    container.replaceChildren();
    const targets = targetBuckets();
    $("strategy-date").textContent = strategyTarget?.latest_date || "暂无目标";
    if (!targets || !(metrics.totalAssets > 0)) {
      const empty = document.createElement("div");
      empty.className = "bar-empty";
      empty.textContent = metrics.totalAssets > 0 ? "目标数据暂不可用" : "录入资产后显示偏离";
      container.appendChild(empty);
      $("largest-gap").textContent = "待录入";
      return;
    }
    const actual = { gold: 0, dividend: 0, a500: 0, bond_futures: 0, cash: 0 };
    metrics.rows.forEach(({ item, calc }) => {
      const bucket = item.strategyBucket;
      if (!(bucket in actual)) return;
      if (bucket === "cash") actual[bucket] += calc.valueCny / metrics.totalAssets;
      else actual[bucket] += calc.exposureCny / metrics.totalAssets;
    });
    const keys = ["gold", "dividend", "a500", "bond_futures", "cash"];
    const scale = Math.max(1, ...keys.flatMap((key) => [Math.abs(actual[key]), Math.abs(targets[key])]));
    let largest = { key: "", gap: 0 };
    keys.forEach((key) => {
      const gap = actual[key] - targets[key];
      if (Math.abs(gap) > Math.abs(largest.gap)) largest = { key, gap };
      container.appendChild(createBarRow(
        bucketLabels[key],
        actual[key],
        scale,
        targets[key],
        `${formatPercent(actual[key])} / ${formatPercent(targets[key])}`
      ));
    });
    $("largest-gap").textContent = `${bucketLabels[largest.key]} ${largest.gap >= 0 ? "+" : ""}${formatPercent(largest.gap)}`;
  }

  function appendCell(row, label, content) {
    const cell = document.createElement("td");
    cell.dataset.label = label;
    if (content instanceof Node) cell.appendChild(content);
    else cell.textContent = content;
    row.appendChild(cell);
    return cell;
  }

  function renderHoldings(metrics) {
    const body = $("holdings-body");
    body.replaceChildren();
    const visible = metrics.rows.filter(({ item }) => activeFilter === "all" || assetClass(item) === activeFilter);
    $("holdings-empty").hidden = vault.holdings.length > 0;
    $("holdings-table-wrap").hidden = vault.holdings.length === 0;
    visible.forEach(({ item, calc }) => {
      const row = document.createElement("tr");
      const identity = document.createElement("div");
      const name = document.createElement("span");
      name.className = "holding-name";
      name.textContent = item.name;
      const meta = document.createElement("span");
      meta.className = "holding-meta";
      meta.textContent = [item.account, item.code, typeLabels[item.assetType]].filter(Boolean).join(" · ");
      identity.append(name, meta);
      appendCell(row, "资产", identity);

      let positionText;
      if (["fixed", "interest"].includes(item.pricingMode)) positionText = formatNative(accruedFixedValue(item), item.currency);
      else positionText = `${formatNumber(item.quantity)} ${calc.derivative ? "手" : "份"}`;
      appendCell(row, "持仓", positionText);
      appendCell(row, "当前价值", item.includeNav ? formatMoney(calc.valueCny) : "不计入");
      appendCell(row, "风险敞口", formatMoney(calc.exposureCny));
      appendCell(row, "资产权重", metrics.totalAssets > 0 && item.includeNav ? formatPercent(calc.valueCny / metrics.totalAssets) : "--");
      const pnlCell = appendCell(row, "累计盈亏", formatMoney(calc.pnlCny));
      setSignedClass(pnlCell, calc.pnlCny);

      const quote = document.createElement("span");
      quote.className = `quote-status${item.quoteStatus === "已更新" ? " ok" : ""}`;
      quote.textContent = item.pricingMode === "auto" ? (item.quoteStatus || "待刷新") : "本地估值";
      appendCell(row, "行情", quote);

      const actions = document.createElement("div");
      actions.className = "table-actions";
      const edit = document.createElement("button");
      edit.className = "table-action";
      edit.type = "button";
      edit.textContent = "编辑";
      edit.dataset.action = "edit";
      edit.dataset.id = item.id;
      const remove = document.createElement("button");
      remove.className = "table-action";
      remove.type = "button";
      remove.textContent = "删除";
      remove.dataset.action = "delete";
      remove.dataset.id = item.id;
      actions.append(edit, remove);
      appendCell(row, "操作", actions);
      body.appendChild(row);
    });
  }

  function renderHistory() {
    const chart = $("history-chart");
    chart.replaceChildren();
    const snapshots = (vault?.snapshots || []).slice(-120);
    $("snapshot-count").textContent = `${snapshots.length}个交易日`;
    if (snapshots.length < 2) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "产生两个以上日终记录后显示走势";
      chart.appendChild(empty);
      return;
    }
    const values = snapshots.map((item) => numeric(item.totalAssets));
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const range = Math.max(maximum - minimum, maximum * 0.02, 1);
    snapshots.forEach((snapshot) => {
      const column = document.createElement("span");
      column.className = "history-column";
      column.style.height = `${18 + (numeric(snapshot.totalAssets) - minimum) / range * 82}%`;
      column.title = `${snapshot.date} ${formatMoney(snapshot.totalAssets)}`;
      chart.appendChild(column);
    });
  }

  function renderAll() {
    if (!vault) return;
    const metrics = portfolioMetrics();
    renderSummary(metrics);
    renderAllocation(metrics);
    renderStrategy(metrics);
    renderHoldings(metrics);
    renderHistory();
  }

  function setFieldVisibility() {
    const type = $("holding-type").value;
    const pricing = $("holding-pricing-mode").value;
    const derivative = type === "futures" || type === "option";
    document.querySelectorAll(".quantity-field").forEach((node) => { node.hidden = ["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".price-field").forEach((node) => { node.hidden = ["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".fixed-field").forEach((node) => { node.hidden = !["fixed", "interest"].includes(pricing); });
    document.querySelectorAll(".interest-field").forEach((node) => { node.hidden = pricing !== "interest"; });
    document.querySelectorAll(".derivative-field").forEach((node) => { node.hidden = !derivative; });
    document.querySelectorAll(".multiplier-field").forEach((node) => { node.hidden = !derivative; });
    document.querySelectorAll(".option-field").forEach((node) => { node.hidden = type !== "option"; });
    $("quote-id-field").hidden = pricing !== "auto";
  }

  function applyTypeDefaults() {
    const type = $("holding-type").value;
    if (["cash", "wealth", "deposit"].includes(type)) {
      $("holding-bucket").value = "cash";
      $("holding-pricing-mode").value = type === "deposit" ? "interest" : "fixed";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    } else if (type === "futures") {
      $("holding-bucket").value = "bond_futures";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "10000";
      $("holding-include-nav").checked = false;
    } else if (type === "option") {
      $("holding-bucket").value = "a500";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "100";
      $("holding-include-nav").checked = false;
    } else if (type === "gold") {
      $("holding-bucket").value = "gold";
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    } else {
      $("holding-pricing-mode").value = "auto";
      $("holding-multiplier").value = "1";
      $("holding-include-nav").checked = true;
    }
    setFieldVisibility();
  }

  function resetHoldingForm() {
    holdingForm.reset();
    $("holding-id").value = "";
    $("holding-type").value = "stock";
    $("holding-bucket").value = "a500";
    $("holding-currency").value = "CNY";
    $("holding-pricing-mode").value = "auto";
    $("holding-direction").value = "1";
    $("holding-multiplier").value = "1";
    $("holding-valuation-date").value = chinaDate();
    $("holding-include-nav").checked = true;
    $("holding-form-error").textContent = "";
    $("dialog-title").textContent = "添加资产";
    setFieldVisibility();
  }

  function openHoldingDialog(item = null) {
    resetHoldingForm();
    if (item) {
      $("dialog-title").textContent = "编辑资产";
      $("holding-id").value = item.id;
      $("holding-account").value = item.account || "";
      $("holding-name").value = item.name || "";
      $("holding-code").value = item.code || "";
      $("holding-type").value = item.assetType || "other";
      $("holding-bucket").value = item.strategyBucket || "other";
      $("holding-currency").value = item.currency || "CNY";
      $("holding-pricing-mode").value = item.pricingMode || "manual";
      $("holding-quote-id").value = item.quoteId || "";
      $("holding-quantity").value = item.quantity ?? "";
      $("holding-price").value = item.price ?? "";
      $("holding-entry-price").value = item.entryPrice ?? "";
      $("holding-direction").value = String(item.direction ?? 1);
      $("holding-multiplier").value = item.multiplier ?? 1;
      $("holding-delta").value = item.delta ?? "";
      $("holding-underlying-price").value = item.underlyingPrice ?? "";
      $("holding-fixed-value").value = item.fixedValue ?? "";
      $("holding-annual-rate").value = numeric(item.annualRate) * 100 || "";
      $("holding-valuation-date").value = item.valuationDate || chinaDate();
      $("holding-notes").value = item.notes || "";
      $("holding-include-nav").checked = Boolean(item.includeNav);
      setFieldVisibility();
    }
    holdingDialog.showModal();
    $("holding-name").focus();
  }

  function formItem() {
    const id = $("holding-id").value;
    const existing = vault.holdings.find((item) => item.id === id) || {};
    return {
      ...existing,
      id: id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
      account: $("holding-account").value.trim(),
      name: $("holding-name").value.trim(),
      code: $("holding-code").value.trim().toUpperCase(),
      assetType: $("holding-type").value,
      strategyBucket: $("holding-bucket").value,
      currency: $("holding-currency").value,
      pricingMode: $("holding-pricing-mode").value,
      quoteId: $("holding-quote-id").value.trim(),
      quantity: numeric($("holding-quantity").value),
      price: numeric($("holding-price").value),
      entryPrice: numeric($("holding-entry-price").value),
      direction: numeric($("holding-direction").value, 1),
      multiplier: numeric($("holding-multiplier").value, 1),
      delta: numeric($("holding-delta").value),
      underlyingPrice: numeric($("holding-underlying-price").value),
      fixedValue: numeric($("holding-fixed-value").value),
      annualRate: numeric($("holding-annual-rate").value) / 100,
      valuationDate: $("holding-valuation-date").value,
      notes: $("holding-notes").value.trim(),
      includeNav: $("holding-include-nav").checked,
      updatedAt: new Date().toISOString()
    };
  }

  function validateItem(item) {
    if (!item.name) return "请填写资产名称";
    if (["fixed", "interest"].includes(item.pricingMode)) {
      if (!(item.fixedValue >= 0)) return "请填写当前金额";
    } else {
      if (!(item.quantity > 0)) return "数量、份额或手数必须大于0";
      if (item.pricingMode === "manual" && !(item.price > 0)) return "请填写当前价格";
      if (item.pricingMode === "auto" && !inferQuoteId(item)) return "无法自动识别行情，请填写行情标识";
    }
    if ((item.assetType === "futures" || item.assetType === "option") && !(item.multiplier > 0)) return "合约乘数必须大于0";
    if (item.assetType === "option" && Math.abs(item.delta) > 1) return "期权Delta必须在-1到1之间";
    return "";
  }

  async function saveHolding(event) {
    event.preventDefault();
    const item = formItem();
    const error = validateItem(item);
    if (error) {
      $("holding-form-error").textContent = error;
      return;
    }
    const index = vault.holdings.findIndex((holding) => holding.id === item.id);
    if (index >= 0) vault.holdings[index] = item;
    else vault.holdings.push(item);
    await persistVault();
    holdingDialog.close();
    renderAll();
    showToast(index >= 0 ? "资产已更新" : "资产已添加");
    if (item.pricingMode === "auto") refreshQuotes({ silent: true });
  }

  async function deleteHolding(id) {
    vault.holdings = vault.holdings.filter((item) => item.id !== id);
    await persistVault();
    renderAll();
    showToast("资产已删除");
  }

  async function exportBackup() {
    await persistVault();
    const encrypted = localStorage.getItem(STORAGE_KEY);
    const backup = {
      format: "allweather-portfolio-vault-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      vault: JSON.parse(encrypted)
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `portfolio-vault-${chinaDate()}.encrypted.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    showToast("加密备份已导出");
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (backup?.format !== "allweather-portfolio-vault-backup" || !backup.vault) throw new Error("备份格式不正确");
      const raw = JSON.stringify(backup.vault);
      const imported = await decryptVault(raw);
      vault = imported;
      localStorage.setItem(STORAGE_KEY, raw);
      renderAll();
      showToast("加密备份已导入");
    } catch (error) {
      showToast("导入失败：密码或备份不匹配");
    } finally {
      $("import-file").value = "";
    }
  }

  async function unlock(event) {
    event.preventDefault();
    if (!window.isSecureContext || !crypto?.subtle) {
      unlockError.textContent = "当前浏览器环境不支持安全加密";
      return;
    }
    unlockError.textContent = "";
    unlockButton.disabled = true;
    unlockButton.textContent = "验证中";
    try {
      const key = await deriveKey(passwordInput.value);
      if (!(await verifyKey(key))) throw new Error("invalid password");
      sessionKey = key;
      await loadVault();
      passwordInput.value = "";
      lockScreen.hidden = true;
      app.hidden = false;
      resetLockTimer();
      await loadStrategyTarget();
      renderAll();
      refreshQuotes({ silent: true });
    } catch (error) {
      sessionKey = null;
      unlockError.textContent = "密码不正确";
      passwordInput.select();
    } finally {
      unlockButton.disabled = false;
      unlockButton.textContent = "解锁台账";
    }
  }

  unlockForm.addEventListener("submit", unlock);
  $("toggle-password").addEventListener("click", () => {
    const visible = passwordInput.type === "text";
    passwordInput.type = visible ? "password" : "text";
    $("toggle-password").textContent = visible ? "显示" : "隐藏";
    $("toggle-password").setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
  });
  $("lock-vault").addEventListener("click", lockVault);
  $("refresh-quotes").addEventListener("click", () => refreshQuotes());
  $("add-holding").addEventListener("click", () => openHoldingDialog());
  $("export-vault").addEventListener("click", exportBackup);
  $("import-file").addEventListener("change", (event) => importBackup(event.target.files?.[0]));
  $("close-dialog").addEventListener("click", () => holdingDialog.close());
  $("cancel-holding").addEventListener("click", () => holdingDialog.close());
  $("holding-type").addEventListener("change", applyTypeDefaults);
  $("holding-pricing-mode").addEventListener("change", setFieldVisibility);
  holdingForm.addEventListener("submit", saveHolding);

  $("holdings-body").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const item = vault.holdings.find((holding) => holding.id === button.dataset.id);
    if (!item) return;
    if (button.dataset.action === "edit") openHoldingDialog(item);
    if (button.dataset.action === "delete") {
      pendingDeleteId = item.id;
      $("confirm-message").textContent = `将从台账中移除“${item.name}”。`;
      confirmDialog.showModal();
    }
  });

  confirmDialog.addEventListener("close", () => {
    if (confirmDialog.returnValue === "confirm" && pendingDeleteId) deleteHolding(pendingDeleteId);
    pendingDeleteId = null;
  });

  document.querySelectorAll(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".filter-button").forEach((node) => node.classList.toggle("active", node === button));
      renderHoldings(portfolioMetrics());
    });
  });

  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, resetLockTimer, { passive: true });
  });
})();
