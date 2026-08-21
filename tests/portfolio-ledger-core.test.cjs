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

test("跨零点沿用涨跌只调整QDII估值，国内基金和黄金不重复计价", () => {
  assert.equal(Core.carriedFundMoveAffectsValue(true, "us-equity"), true);
  assert.equal(Core.carriedFundMoveAffectsValue(true, "cn-equity"), false);
  assert.equal(Core.carriedFundMoveAffectsValue(true, "gold"), false);
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

test("常见资产自动归入策略大类，海外指数不硬塞进国内策略", () => {
  assert.equal(Core.inferStrategyBucket({ assetType: "stock", name: "腾讯控股", code: "00700.HK" }), "a500");
  assert.equal(Core.inferStrategyBucket({ assetType: "fund", name: "红利低波基金" }), "dividend");
  assert.equal(Core.inferStrategyBucket({ assetType: "fund", name: "黄金ETF联接", code: "004253" }), "gold");
  assert.equal(Core.inferStrategyBucket({ assetType: "fund", name: "标普500 QDII" }), "other");
});

test("底层资产视图将国债期货和期货保证金放入同一个一级组", () => {
  assert.equal(Core.isBondFuturesGroupMember({ assetType: "futures", code: "T2609.CFE" }), true);
  assert.equal(Core.isBondFuturesGroupMember({ assetType: "cash", name: "期货保证金", account: "期货账户" }), true);
  assert.equal(Core.isBondFuturesGroupMember({ assetType: "cash", name: "银行活期", account: "招商银行" }), false);
});

test("历史期间盈亏扣除转入和更正，并以期间资金基数计算收益率", () => {
  const result = Core.historyPeriodMetrics({
    previousTotal: 100000,
    currentTotal: 112000,
    capitalFlow: 10000,
    adjustment: 500,
    investedBase: 105000
  });
  assert.equal(result.change, 1500);
  assert.equal(result.rate, 1500 / 105000);
});

test("个人组合和基准的累计收益均按期间收益复合", () => {
  const afterGain = Core.chainReturn(0, 0.1);
  const afterLoss = Core.chainReturn(afterGain, -0.05);
  assert.ok(Math.abs(afterGain - 0.1) < 1e-12);
  assert.ok(Math.abs(afterLoss - 0.045) < 1e-12);
  assert.equal(Core.chainReturn(null, 0.1), null);
});

test("收益率对比以共同起点归零，并把缺少个人记录日的基准收益继续复合", () => {
  const points = Core.cumulativeComparison({
    baseDate: "2026-08-01",
    periods: [
      { date: "2026-08-02", rate: 0.1 },
      { date: "2026-08-05", rate: -0.05, estimated: true }
    ],
    benchmarkDates: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-05"],
    benchmarkReturns: [0, 0.02, 0.03, -0.01]
  });
  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[2].personalReturn - 0.045) < 1e-12);
  assert.ok(Math.abs(points[2].benchmarkReturn - (1.02 * 1.03 * 0.99 - 1)) < 1e-12);
  assert.equal(points[2].estimated, true);
  assert.ok(Math.abs(points[2].excessReturn - (points[2].personalReturn - points[2].benchmarkReturn)) < 1e-12);
});

test("个人表现指标按资金流调整后的期间收益复合并计算回撤", () => {
  const stats = Core.performanceStats({
    baseDate: "2026-06-01",
    periods: [
      { startDate: "2026-06-01", date: "2026-06-10", rate: 0.1 },
      { startDate: "2026-06-10", date: "2026-07-01", rate: -0.05 },
      { startDate: "2026-07-01", date: "2026-07-15", rate: 0.02 },
      { startDate: "2026-07-15", date: "2026-07-25", rate: 0.01 },
      { startDate: "2026-07-25", date: "2026-08-10", rate: -0.01 },
      { startDate: "2026-08-10", date: "2026-08-20", rate: 0.005 }
    ]
  });
  assert.ok(Math.abs(stats.totalReturn - (1.1 * 0.95 * 1.02 * 1.01 * 0.99 * 1.005 - 1)) < 1e-12);
  assert.ok(Math.abs(stats.maxDrawdown - -0.05) < 1e-12);
  assert.ok(stats.currentDrawdown < 0);
  assert.equal(stats.positiveRatio, 4 / 6);
  assert.ok(Number.isFinite(stats.recentReturn));
  assert.ok(Number.isFinite(stats.annualizedVolatility));
});

test("表现记录不足时不伪造30日收益和年化波动率", () => {
  const stats = Core.performanceStats({
    baseDate: "2026-08-18",
    periods: [{ startDate: "2026-08-18", date: "2026-08-20", rate: 0.01 }]
  });
  assert.equal(stats.recentReturn, null);
  assert.equal(stats.annualizedVolatility, null);
  assert.equal(stats.maxDrawdown, 0);
});
