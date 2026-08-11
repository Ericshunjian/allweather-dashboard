(function portfolioLedgerCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PortfolioLedgerCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const knownUnderlyingRules = Object.freeze([
    { id: "SP500", label: "标普500", pattern: /标普\s*500|S\s*&\s*P\s*500|S\s*P\s*500|(?:^|\s)(?:SPY|VOO|IVV|SPLG)(?:\.US)?(?:$|\s)/i },
    { id: "NASDAQ100", label: "纳斯达克100", pattern: /纳斯达克\s*100|纳指\s*100|NASDAQ\s*100|(?:^|\s)QQQ(?:M)?(?:\.US)?(?:$|\s)/i },
    { id: "CSI300", label: "沪深300", pattern: /沪深\s*300|CSI\s*300/i },
    { id: "CSI_A500", label: "中证A500", pattern: /中证\s*A\s*500|(?:^|\s)A500(?:$|\s)/i },
    { id: "GOLD", label: "黄金", pattern: /黄金|GOLD|518880|004253/i },
    { id: "TENCENT", label: "腾讯", pattern: /腾讯控股|TENCENT(?:\s+HOLDINGS)?|(?:^|\s)(?:HK)?0*700(?:\.HK)?(?:$|\s)/i },
    { id: "DIVIDEND_LOW_VOL", label: "红利低波", pattern: /红利.*低波|低波.*红利|921446|931446/i },
    { id: "CN_BOND_FUTURES", label: "国债期货", pattern: /国债期货|(?:^|\s)(?:T|TF|TS|TL)(?:0|\d{3,4})?(?:\.CFE)?(?:$|\s)/i }
  ]);

  function normalizedToken(value) {
    return String(value || "")
      .trim()
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s·_\-—/()（）&.]+/g, "");
  }

  function descriptorFor(item) {
    return [item?.name, item?.code, item?.quoteName, item?.underlyingName]
      .filter(Boolean)
      .join(" ");
  }

  function knownUnderlyingIdentity(item) {
    const known = knownUnderlyingRules.find((rule) => rule.pattern.test(descriptorFor(item)));
    return known ? { id: known.id, key: `known:${known.id}`, label: known.label, known: true } : null;
  }

  function stableUnderlyingIdentity(item) {
    const known = knownUnderlyingIdentity(item);
    if (known) return known;
    const savedId = String(item?.underlyingId || "").trim();
    const explicit = String(item?.underlyingName || "").trim();
    if (savedId) {
      return {
        id: savedId,
        key: `stable:${savedId}`,
        label: explicit || String(item?.name || item?.code || savedId),
        known: !savedId.startsWith("CUSTOM:")
      };
    }
    if (explicit && !/^(?:AH股|美股|港股|国内权益)$/i.test(explicit)) {
      const token = normalizedToken(explicit);
      if (token) return { id: `CUSTOM:${token}`, key: `stable:CUSTOM:${token}`, label: explicit, known: false };
    }
    return null;
  }

  function inferEquityMarket(item) {
    const descriptor = descriptorFor(item);
    if (/标普|S\s*&\s*P|纳斯达克|纳指|NASDAQ|美股|美国|(?:^|\s)(?:SPY|VOO|IVV|SPLG|QQQ|QQQM)(?:\.US)?(?:$|\s)/i.test(descriptor)) {
      return { key: "us-equity", label: "美股" };
    }
    if (/恒生|港股|香港|(?:^|\s)(?:HSI|HSCEI)(?:$|\s)/i.test(descriptor)) {
      return { key: "hk-equity", label: "港股" };
    }
    return null;
  }

  function isTencentDomesticBroadProxy(item) {
    return knownUnderlyingIdentity(item)?.id === "TENCENT";
  }

  function fundReferenceEligible(item, assetClassKey, marketKey) {
    return item?.assetType === "fund"
      && item?.pricingMode === "auto"
      && item?.intradayEstimateEnabled !== false
      && (item?.currency || "CNY") === "CNY"
      && item?.strategyBucket !== "gold"
      && assetClassKey === "equity"
      && ["cn-equity", "us-equity"].includes(marketKey);
  }

  function inferStrategyBucket(item) {
    const type = String(item?.assetType || "");
    const knownId = knownUnderlyingIdentity(item)?.id;
    const descriptor = descriptorFor(item);
    if (["cash", "wealth", "deposit"].includes(type)) return "cash";
    if (type === "futures" || knownId === "CN_BOND_FUTURES") return "bond_futures";
    if (type === "gold" || knownId === "GOLD") return "gold";
    if (knownId === "DIVIDEND_LOW_VOL" || /红利.*低波|低波.*红利/i.test(descriptor)) return "dividend";
    if (["TENCENT", "CSI300", "CSI_A500"].includes(knownId) || /国内宽基|A股宽基/i.test(descriptor)) return "a500";
    return "other";
  }

  function isBondFuturesGroupMember(item) {
    if (knownUnderlyingIdentity(item)?.id === "CN_BOND_FUTURES" || item?.strategyBucket === "bond_futures") return true;
    const descriptor = [item?.name, item?.underlyingName, item?.notes].filter(Boolean).join(" ");
    if (/期货.*保证金|保证金.*期货/.test(descriptor)) return true;
    const cashLike = ["cash", "wealth", "deposit"].includes(String(item?.assetType || ""));
    return cashLike
      && /期货/.test(String(item?.account || ""))
      && /保证金|现金/.test(String(item?.name || ""));
  }

  function businessDaysElapsed(fromDate, toDate) {
    if (!fromDate || !toDate || fromDate > toDate) return NaN;
    const cursor = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);
    if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return NaN;
    let days = 0;
    while (cursor < end) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      const weekday = cursor.getUTCDay();
      if (weekday !== 0 && weekday !== 6) days += 1;
    }
    return days;
  }

  function quoteFreshness({ pricingMode, quoteTime, quoteStatus, isFund = false, isQdii = false, today }) {
    if (pricingMode !== "auto") return { state: "manual", stale: false, label: "本地估值" };
    if (!quoteTime) return { state: "missing", stale: true, label: "缺少行情" };
    if (quoteStatus === "更新失败") return { state: "error", stale: true, label: "更新失败" };
    const quoteDate = String(quoteTime).slice(0, 10);
    const age = businessDaysElapsed(quoteDate, today);
    const allowed = isQdii ? 4 : (isFund ? 2 : 1);
    if (!Number.isFinite(age) || age > allowed) {
      return { state: "stale", stale: true, label: `行情过期 · ${quoteDate || "日期未知"}`, age };
    }
    return { state: "fresh", stale: false, label: "行情正常", age };
  }

  function estimatedNativeValue(nativeValue, nativeDailyPnl, estimated, carried) {
    return Number(nativeValue || 0) + (estimated || carried ? Number(nativeDailyPnl || 0) : 0);
  }

  function entryFlowDate(entry) {
    return String(entry?.flowDate || entry?.date || "");
  }

  function historyPeriodMetrics({ currentTotal, previousTotal, capitalFlow = 0, adjustment = 0, investedBase = previousTotal }) {
    const change = Number(currentTotal) - Number(previousTotal) - Number(capitalFlow) - Number(adjustment);
    const denominator = Number(investedBase);
    return {
      change,
      rate: Number.isFinite(denominator) && Math.abs(denominator) > 1e-12 ? change / denominator : null
    };
  }

  function futuresValuation({ quantity, price, entry, previousClose, multiplier, direction, resetToday, quotePending, includeNav }) {
    const side = Number(direction) < 0 ? -1 : 1;
    const reference = resetToday ? Number(entry) : Number(previousClose);
    const exposure = side * Number(quantity) * Number(price) * Number(multiplier);
    const pnl = side * Number(quantity) * (Number(price) - Number(entry)) * Number(multiplier);
    const dailyPnl = quotePending ? 0 : side * Number(quantity) * (Number(price) - reference) * Number(multiplier);
    return { exposure, pnl, dailyPnl, value: includeNav ? pnl : 0 };
  }

  function mergeById(localItems = [], remoteItems = [], timestampForItem = (item) => item.updatedAt || item.createdAt) {
    const merged = new Map();
    [...remoteItems, ...localItems].forEach((source) => {
      if (!source?.id) return;
      const item = JSON.parse(JSON.stringify(source));
      const current = merged.get(item.id);
      const itemTime = Date.parse(timestampForItem(item) || "") || 0;
      const currentTime = Date.parse(timestampForItem(current || {}) || "") || 0;
      if (!current || itemTime >= currentTime) merged.set(item.id, item);
    });
    return [...merged.values()];
  }

  return Object.freeze({
    businessDaysElapsed,
    entryFlowDate,
    estimatedNativeValue,
    fundReferenceEligible,
    futuresValuation,
    historyPeriodMetrics,
    inferStrategyBucket,
    inferEquityMarket,
    isTencentDomesticBroadProxy,
    isBondFuturesGroupMember,
    knownUnderlyingIdentity,
    mergeById,
    normalizedToken,
    quoteFreshness,
    stableUnderlyingIdentity
  });
});
