const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../portfolio/ledger-core.js");

test("不同渠道和名称的标普500使用同一个稳定底层标识", () => {
  const qdii = Core.stableUnderlyingIdentity({ name: "某标普500 QDII", code: "000001", assetType: "fund" });
  const etf = Core.stableUnderlyingIdentity({ name: "SPDR S&P 500 ETF", code: "SPY.US", assetType: "etf" });
  assert.equal(qdii.id, "SP500");
  assert.equal(etf.id, "SP500");
});

test("人民币计价的标普和纳指 QDII 仍归入美股", () => {
  assert.equal(Core.inferEquityMarket({ name: "标普500 QDII", currency: "CNY" }).key, "us-equity");
  assert.equal(Core.inferEquityMarket({ underlyingName: "纳斯达克100", currency: "CNY" }).key, "us-equity");
});

test("腾讯可稳定识别为国内宽基替代品", () => {
  assert.equal(Core.isTencentDomesticBroadProxy({ name: "腾讯控股", code: "00700.HK" }), true);
});

test("黄金基金不会启用盘中权益参考估值", () => {
  const goldFund = {
    assetType: "fund",
    pricingMode: "auto",
    intradayEstimateEnabled: true,
    currency: "CNY",
    strategyBucket: "gold"
  };
  assert.equal(Core.fundReferenceEligible(goldFund, "gold", "gold"), false);
});

test("场外基金参考涨跌会进入当前估值，但正式净值不重复增加", () => {
  assert.equal(Core.estimatedNativeValue(100000, 1200, true, false), 101200);
  assert.equal(Core.estimatedNativeValue(100000, 1200, false, false), 100000);
});

test("国债期货成本等于收盘价时累计和当日盈亏都为零", () => {
  const result = Core.futuresValuation({
    quantity: 2,
    price: 109.36,
    entry: 109.36,
    previousClose: 109.36,
    multiplier: 10000,
    direction: 1,
    resetToday: false,
    quotePending: false,
    includeNav: true
  });
  assert.equal(result.pnl, 0);
  assert.equal(result.dailyPnl, 0);
  assert.equal(result.value, 0);
});

test("QDII 净值允许更长更新时间，但明显过期仍提示", () => {
  const recentQdii = Core.quoteFreshness({
    pricingMode: "auto",
    quoteTime: "2026-08-07T12:00:00Z",
    quoteStatus: "基金净值",
    isFund: true,
    isQdii: true,
    today: "2026-08-11"
  });
  const staleDomestic = Core.quoteFreshness({
    pricingMode: "auto",
    quoteTime: "2026-08-05T12:00:00Z",
    quoteStatus: "基金净值",
    isFund: true,
    isQdii: false,
    today: "2026-08-11"
  });
  assert.equal(recentQdii.stale, false);
  assert.equal(staleDomestic.stale, true);
});

test("跨设备合并时同一记录保留更新时间更新的一份", () => {
  const merged = Core.mergeById(
    [{ id: "holding-1", name: "新名称", updatedAt: "2026-08-11T10:00:00Z" }],
    [{ id: "holding-1", name: "旧名称", updatedAt: "2026-08-11T09:00:00Z" }, { id: "holding-2", name: "另一资产", updatedAt: "2026-08-11T09:30:00Z" }]
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.id === "holding-1").name, "新名称");
});

test("补录交易按录入日扣除资金流，避免历史收益被虚增", () => {
  assert.equal(Core.entryFlowDate({ date: "2026-07-01", flowDate: "2026-08-11" }), "2026-08-11");
  assert.equal(Core.entryFlowDate({ date: "2026-07-01" }), "2026-07-01");
});
