import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useUsageFirstDate, useUsageTrends } from "@/lib/query/usage";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fmtInt,
  formatHitRatePercent,
  formatTokensShort,
  getLocaleFromLanguage,
  parseFiniteNumber,
  resolveTrendChartType,
  TREND_CHART_TYPES,
  type TrendChartType,
} from "./format";
import { resolveUsageRange } from "@/lib/usageRange";
import type {
  ModelTrendStats,
  RuntimeTrendStats,
  UsageRangeSelection,
  UsageTrendPeriod,
} from "@/types/usage";
import { useMoneyFormat } from "@/hooks/useMoneyFormat";
import { useSettingsQuery } from "@/lib/query";
import type { UsageMetric } from "./rememberedChoice";
import { runtimeColor, runtimeName } from "./runtimePalette";
import { UsageHeatmap } from "./UsageHeatmap";
import { buildModelTrendSeries } from "./modelTrendSeries";

interface UsageTrendChartProps {
  range: UsageRangeSelection;
  /** 画哪个指标：由上方指标条选 */
  metric: UsageMetric;
  appType?: string;
  providerName?: string;
  model?: string;
  refreshIntervalMs: number;
  onChartTypeChange?: (
    next: TrendChartType,
  ) => Promise<boolean> | boolean | void;
}

export interface UsageTrendStatLike {
  date: string;
  requestCount?: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCost: string | number;
  runtimeStats?: RuntimeTrendStats[];
  modelStats?: ModelTrendStats[];
}

export interface UsageTrendChartPoint {
  /** Unique category key for Recharts — must not collide across years. */
  xKey: string;
  rawDate: string;
  /** Short tick label shown on the X axis. */
  label: string;
  /** Fuller label used by the selected interval. */
  tooltipLabel: string;
  hour: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** 请求数（「请求」指标） */
  requests: number;
  /** 真实消耗 Tokens = 新增输入 + 输出 + 缓存写入 + 缓存命中（和指标卡同口径） */
  tokens: number;
  cost: number | null;
  /** 缓存命中率（0–1）= 缓存命中 ÷（新增输入 + 缓存写入 + 缓存命中），和指标条同口径；没有输入时为 null */
  hitRate: number | null;
  runtimeStats: Record<string, TrendMetrics>;
  modelStats?: ModelTrendStats[];
}

type TrendMetrics = Pick<UsageTrendChartPoint, UsageMetric> & {
  cacheableInput: number;
};
const DEFAULT_COLOR = "var(--chart-usage)";

export function trendMetricsOf(
  stat: Omit<UsageTrendStatLike, "date" | "runtimeStats" | "modelStats">,
): TrendMetrics {
  return {
    requests: stat.requestCount ?? 0,
    tokens:
      stat.totalInputTokens +
      stat.totalOutputTokens +
      stat.totalCacheCreationTokens +
      stat.totalCacheReadTokens,
    cost: parseFiniteNumber(stat.totalCost) ?? null,
    hitRate: hitRateOf(stat),
    cacheableInput:
      stat.totalInputTokens +
      stat.totalCacheCreationTokens +
      stat.totalCacheReadTokens,
  };
}

/** 缓存命中率（0–1）；分母（新增输入 + 缓存写入 + 缓存命中）为 0 时没有意义，返回 null */
export function hitRateOf(
  stat: Pick<
    UsageTrendStatLike,
    "totalInputTokens" | "totalCacheCreationTokens" | "totalCacheReadTokens"
  >,
): number | null {
  const cacheable =
    stat.totalInputTokens +
    stat.totalCacheCreationTokens +
    stat.totalCacheReadTokens;
  return cacheable > 0 ? stat.totalCacheReadTokens / cacheable : null;
}

/**
 * 命中率 Y 轴的下限：命中率通常都在 90% 以上，从 0 画起柱子几乎一样高。
 * 取这批数据的最低值，往下再留半个「最低值到 100%」的距离（至少 2 个百分点）当余量，
 * 再向下取整到 5% 的整数档；上限固定 100%。没有数据、或算出来低于 50% 时从 0 画。Exported for unit tests.
 */
export function hitRateAxisFloor(rates: (number | null)[]): number {
  const known = rates.filter((rate): rate is number => rate != null);
  if (known.length === 0) return 0;
  const min = Math.min(...known);
  const padded = min - Math.max((1 - min) / 2, 0.02);
  // 加一点容差：0.95 * 20 在浮点下是 18.999…，直接取整会多掉一档
  const floor = Math.floor(padded * 20 + 1e-9) / 20;
  // 数据本身跨度很大（最低值远低于 50%）时截断已无意义，照常从 0 画
  return floor < 0.5 ? 0 : floor;
}

/** Build chart rows from backend trend stats. Exported for unit tests. */
export function buildUsageTrendChartData(
  trends: UsageTrendStatLike[] | undefined,
  options: {
    isHourly: boolean;
    period?: UsageTrendPeriod;
    dateLocale: string;
    /** Inclusive range endpoints (unix seconds). Used to decide year labels. */
    startDate: number;
    endDate: number;
  },
): UsageTrendChartPoint[] {
  const { isHourly, period, dateLocale, startDate, endDate } = options;
  const startYear = new Date(startDate * 1000).getFullYear();
  const endYear = new Date(endDate * 1000).getFullYear();
  const spansMultipleYears = startYear !== endYear;
  // 按小时时刻度只写钟点（日期在标题和时间范围里已经有）；跨天的范围在 0 点那格写日期，标出换日
  const spansMultipleDays =
    new Date(startDate * 1000).toDateString() !==
    new Date(endDate * 1000).toDateString();

  return (
    trends?.map((stat) => {
      const pointDate = new Date(stat.date);
      // Prefer a stable unique key from the source timestamp / date string.
      // Falling back to ISO keeps categories unique even if the backend
      // returns sparse points that share the same local MM/DD across years.
      const xKey = stat.date;
      const tooltipLabel = isHourly
        ? pointDate.toLocaleString(dateLocale, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : pointDate.toLocaleDateString(dateLocale, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
      const label = isHourly
        ? spansMultipleDays && pointDate.getHours() === 0
          ? pointDate.toLocaleDateString(dateLocale, {
              month: "2-digit",
              day: "2-digit",
            })
          : pointDate.toLocaleTimeString(dateLocale, {
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
            })
        : period === "month"
          ? pointDate.toLocaleDateString(dateLocale, {
              month: "short",
              ...(spansMultipleYears ? { year: "2-digit" } : {}),
            })
          : spansMultipleYears
            ? pointDate.toLocaleDateString(dateLocale, {
                year: "2-digit",
                month: "2-digit",
                day: "2-digit",
              })
            : pointDate.toLocaleDateString(dateLocale, {
                month: "2-digit",
                day: "2-digit",
              });

      return {
        xKey,
        rawDate: stat.date,
        label,
        tooltipLabel,
        hour: pointDate.getHours(),
        inputTokens: stat.totalInputTokens,
        outputTokens: stat.totalOutputTokens,
        cacheCreationTokens: stat.totalCacheCreationTokens,
        cacheReadTokens: stat.totalCacheReadTokens,
        ...trendMetricsOf(stat),
        modelStats: stat.modelStats,
        runtimeStats: Object.fromEntries(
          (stat.runtimeStats ?? []).map((runtime) => [
            runtime.appType,
            trendMetricsOf(runtime),
          ]),
        ),
      };
    }) || []
  );
}

/** Resolve a tick label by the unique category key (not by filtered tick index). */
export function formatUsageTrendTickLabel(
  xKey: string,
  chartData: UsageTrendChartPoint[],
): string {
  const point = chartData.find((row) => row.xKey === xKey);
  return point?.label ?? xKey;
}

export interface UsageTrendTokenTickFormatter {
  format(value: number): string;
}

/**
 * 中日文的「万」「亿」各管四位数，5000万、2000亿 比英文的 50M、200B 宽一截，
 * 会把纵轴撑宽；这两段改写成 5千万、2千亿。
 */
function cjkThousandUnits(locale: string): Array<[number, string]> | null {
  if (locale === "zh-TW") {
    return [
      [1e11, "千億"],
      [1e7, "千萬"],
    ];
  }
  if (locale === "zh" || locale.startsWith("zh-")) {
    return [
      [1e11, "千亿"],
      [1e7, "千万"],
    ];
  }
  if (locale === "ja" || locale.startsWith("ja-")) {
    return [
      [1e11, "千億"],
      [1e7, "千万"],
    ];
  }
  return null;
}

export function createUsageTrendTokenTickFormatter(
  locale: string,
): UsageTrendTokenTickFormatter {
  // 不支持的语言统一退回英文，避免 Intl 隐式使用系统语言（例如中文单位）。
  locale = Intl.NumberFormat.supportedLocalesOf(locale)[0] ?? "en-US";
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  });
  const units = cjkThousandUnits(locale);
  if (!units) return compact;
  const plain = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return {
    format(value) {
      const abs = Math.abs(value);
      for (const [size, unit] of units) {
        if (abs < size || abs >= size * 10) continue;
        const scaled = Number((value / size).toFixed(1));
        // 9.96 千万这类进位到 10 的，交回原格式（9960万）
        if (Math.abs(scaled) < 10) return `${plain.format(scaled)}${unit}`;
      }
      return compact.format(value);
    },
  };
}

export function formatUsageTrendTokenTickLabel(
  value: unknown,
  formatter: UsageTrendTokenTickFormatter,
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return "--";

  return formatter.format(num);
}

const AXIS_TICK = { fill: "var(--text-3)", fontSize: 11 };
const CHART_HEIGHT = 236;
const DAY_SECONDS = 24 * 60 * 60;

function localDayNumber(timestamp: number) {
  const date = new Date(timestamp * 1000);
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
    (DAY_SECONDS * 1000)
  );
}

function trendPeriod(
  startDate: number,
  endDate: number,
): UsageTrendPeriod | undefined {
  if (endDate - startDate <= DAY_SECONDS) return undefined;
  const dayCount = localDayNumber(endDate) - localDayNumber(startDate) + 1;
  if (dayCount > 120) return "month";
  if (dayCount > 31) return "week";
  return "day";
}

/**
 * 量容器宽度给图表用，不用 Recharts 的 ResponsiveContainer / responsive：它们在 ResizeObserver 回调里排一次异步渲染，
 * 侧栏开合时图表会按旧宽度多画一帧，右边缘先错位再跳回来。ResizeObserver 回调在绘制前执行，
 * 这里用 flushSync 当场按新宽度重画，屏幕上第一帧就是对的。
 */
function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      flushSync(() => setWidth(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function UsageTrendChart({
  range,
  metric,
  appType,
  providerName,
  model,
  refreshIntervalMs,
  onChartTypeChange,
}: UsageTrendChartProps) {
  const { t, i18n } = useTranslation();
  const { moneyCompact, moneyTick, rate } = useMoneyFormat();
  const { data: settings } = useSettingsQuery();
  const savedChartType = resolveTrendChartType(settings?.usageDisplay);
  const [chartType, setChartType] = useState(savedChartType);
  const [savingChartType, setSavingChartType] = useState(false);
  const [groupBy, setGroupBy] = useState<"total" | "app" | "model">("app");
  const isAllTime = range.preset === "all";
  const [wasAllTime, setWasAllTime] = useState(isAllTime);
  const [showHeatmap, setShowHeatmap] = useState(isAllTime);
  const [previewKey, setPreviewKey] = useState<string>();
  const [pinnedTime, setPinnedTime] = useState<number>();
  useEffect(() => setChartType(savedChartType), [savedChartType]);

  if (wasAllTime !== isAllTime) {
    setWasAllTime(isAllTime);
    setPreviewKey(undefined);
    if (isAllTime) setShowHeatmap(true);
  }

  const changeChartType = async (next: TrendChartType) => {
    setShowHeatmap(false);
    setPreviewKey(undefined);
    setChartType(next);
    if (!onChartTypeChange) return;
    setSavingChartType(true);
    try {
      if ((await onChartTypeChange(next)) === false) {
        setChartType(savedChartType);
      }
    } catch {
      setChartType(savedChartType);
    } finally {
      setSavingChartType(false);
    }
  };
  const filters = { appType, providerName, model };
  const refetchInterval = refreshIntervalMs > 0 ? refreshIntervalMs : false;
  const firstDate = useUsageFirstDate(filters, {
    enabled: isAllTime,
    refetchInterval,
  });
  const firstTimestamp = firstDate.data
    ? Date.parse(`${firstDate.data}T00:00:00`) / 1000
    : undefined;
  const chartRange: UsageRangeSelection =
    isAllTime && firstTimestamp != null
      ? { preset: "custom", customStartDate: firstTimestamp, liveEndTime: true }
      : range;
  const { startDate, endDate } = resolveUsageRange(chartRange);
  const hasRange =
    !isAllTime || (firstTimestamp != null && startDate <= endDate);
  const period = showHeatmap
    ? "day"
    : (trendPeriod(startDate, endDate) ?? (isAllTime ? "day" : undefined));
  const isHourly = period == null;
  const modelMetric =
    metric === "hitRate"
      ? undefined
      : (
          {
            cost: "totalCost",
            requests: "requestCount",
            tokens: "totalTokens",
          } as const
        )[metric];
  const showModels = !showHeatmap && groupBy === "model" && modelMetric != null;
  const trendsQuery = useUsageTrends(chartRange, filters, {
    enabled: hasRange,
    period,
    includeModels: showModels,
    refetchInterval,
  });
  const isLoading =
    (isAllTime && firstDate.isLoading) ||
    (hasRange && (trendsQuery.isLoading || trendsQuery.isPlaceholderData));
  const trends = hasRange && !isLoading ? trendsQuery.data : undefined;
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const dateLocale = getLocaleFromLanguage(language);
  const tokenTickFormatter = useMemo(
    () => createUsageTrendTokenTickFormatter(dateLocale),
    [dateLocale],
  );

  const chartData = useMemo(
    () =>
      buildUsageTrendChartData(trends, {
        isHourly,
        period,
        dateLocale,
        startDate,
        endDate,
      }),
    [trends, isHourly, period, dateLocale, startDate, endDate],
  );

  const activePoint = useMemo(() => {
    const pinnedPoint =
      pinnedTime != null && pinnedTime >= startDate && pinnedTime <= endDate
        ? chartData.find((_, index) => {
            const next = chartData[index + 1];
            return !next || pinnedTime < Date.parse(next.rawDate) / 1000;
          })
        : undefined;
    return (
      chartData.find(({ xKey }) => xKey === previewKey) ??
      pinnedPoint ??
      [...chartData].reverse().find((point) => point.requests > 0) ??
      chartData[chartData.length - 1]
    );
  }, [chartData, endDate, pinnedTime, previewKey, startDate]);
  const activeValue = activePoint?.[metric];
  const percentage = useMemo(
    () =>
      new Intl.NumberFormat(dateLocale, {
        style: "percent",
        maximumFractionDigits: 1,
      }),
    [dateLocale],
  );
  const intervalOptions = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(dateLocale, {
      month: "short",
      day: "numeric",
      ...(isHourly
        ? { hour: "2-digit", minute: "2-digit" }
        : period === "day"
          ? { weekday: "short" }
          : {}),
      ...(new Date(startDate * 1000).getFullYear() !==
      new Date(endDate * 1000).getFullYear()
        ? { year: "numeric" }
        : {}),
    });
    return chartData.map(({ rawDate, tooltipLabel, xKey }, index) => {
      const date = new Date(rawDate);
      const next = chartData[index + 1];
      const end = new Date(
        next ? Date.parse(next.rawDate) - 1000 : endDate * 1000,
      );
      const isPeriod = period === "week" || period === "month";
      return {
        xKey,
        label: Number.isNaN(date.getTime())
          ? tooltipLabel
          : isPeriod && end > date && end.toDateString() !== date.toDateString()
            ? `${formatter.format(date)} – ${formatter.format(end)}`
            : formatter.format(date),
      };
    });
  }, [chartData, dateLocale, endDate, isHourly, period, startDate]);

  // 单指标：图只画指标条选中的那一个，单 Y 轴，标题和明细跟着走。
  const metricLabel = {
    cost: t("usage.trend.cost"),
    requests: t("usage.trend.requestsLegend"),
    tokens: t("usage.trend.tokens"),
    hitRate: t("usage.cacheHitRate"),
  }[metric];
  const granularity = showHeatmap
    ? t("usage.heatmap.daily")
    : t(
        {
          hour: "usage.trend.hourly",
          day: "usage.trend.daily",
          week: "usage.trend.weekly",
          month: "usage.trend.monthly",
        }[period ?? "hour"],
      );

  const formatMetric = (value: number | null | undefined) => {
    if (value == null) return "—";
    if (metric === "cost") return moneyCompact(value);
    if (metric === "hitRate") return formatHitRatePercent(value);
    return fmtInt(value, dateLocale);
  };
  const formatYTick = (value: unknown) => {
    if (metric === "cost") return moneyTick(value);
    // 下限常是 95% 这类，中间刻度会落在 97.5%，留一位小数
    if (metric === "hitRate")
      return `${+((Number(value) || 0) * 100).toFixed(1)}%`;
    return formatUsageTrendTokenTickLabel(value, tokenTickFormatter);
  };
  const formatSummary = (value: number | null | undefined) =>
    metric === "tokens" && value != null
      ? formatTokensShort(value, language, 2)
      : formatMetric(value);

  const runtimes = useMemo(
    () =>
      Array.from(
        new Set(chartData.flatMap((point) => Object.keys(point.runtimeStats))),
      ).sort(),
    [chartData],
  );
  const canGroupByApp = (!appType || appType === "all") && runtimes.length > 1;
  const seriesApps =
    canGroupByApp && groupBy !== "total" && !showModels ? runtimes : [];
  const mode = showModels ? "model" : seriesApps.length ? "app" : "total";
  const modelSeries = useMemo(
    () =>
      showModels && modelMetric
        ? buildModelTrendSeries(chartData, modelMetric)
        : [],
    [chartData, modelMetric, showModels],
  );
  const appSeries = (app: string) => ({
    key: `app:${app}`,
    name: runtimeName(app),
    color: runtimeColor(app),
    value: (point: UsageTrendChartPoint) => point.runtimeStats[app]?.[metric],
  });
  const legend = showHeatmap
    ? runtimes.map(appSeries)
    : showModels
      ? modelSeries.map((series) => ({
          ...series,
          name:
            series.model == null
              ? t("usage.trend.otherModels")
              : series.model || t("usage.trend.unknownModel"),
        }))
      : seriesApps.map(appSeries);
  const plotSeries =
    !showHeatmap && legend.length
      ? legend
      : [
          {
            key: "total",
            name: metricLabel,
            color: DEFAULT_COLOR,
            value: (point: UsageTrendChartPoint) => point[metric],
          },
        ];
  const breakdown = activePoint
    ? (showModels
        ? legend
        : Object.keys(activePoint.runtimeStats).map(appSeries)
      )
        .map((series) => ({ ...series, value: series.value(activePoint) }))
        .filter(({ value }) => !showModels || value !== 0)
        .sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))
    : [];
  const hitRateFloor = useMemo(
    () =>
      hitRateAxisFloor(
        chartData.flatMap((point) =>
          seriesApps.length
            ? seriesApps.map((app) => point.runtimeStats[app]?.hitRate ?? null)
            : [point.hitRate],
        ),
      ),
    [chartData, seriesApps],
  );
  const Chart = chartType === "bar" ? BarChart : LineChart;
  const [chartBoxRef, chartWidth] = useContainerWidth();
  const toggleClass = (active: boolean) =>
    cn(
      "rounded-[6px] px-2 py-1 text-caption whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
      active ? "bg-surface text-fg-1 shadow-sm" : "text-fg-2 hover:text-fg-1",
    );
  const pinInterval = (key: string) => {
    setPreviewKey(undefined);
    setPinnedTime(Math.max(startDate, Date.parse(key) / 1000));
  };

  return (
    <section
      aria-labelledby="usage-trend-title"
      className="px-4 pb-3 pt-5 [container-type:inline-size]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2
          id="usage-trend-title"
          className="m-0 min-h-7 whitespace-nowrap text-caption font-semibold leading-7 text-fg-2"
        >
          {t("usage.trend.titleMetric", {
            metric: metricLabel,
            granularity,
          })}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {(canGroupByApp || modelMetric != null) && !showHeatmap && (
            <div className="inline-flex gap-0.5 rounded-[8px] bg-subtle p-0.5">
              {(
                [
                  ["total", t("usage.detail.total"), true],
                  ["app", t("usage.app"), canGroupByApp],
                  ["model", t("usage.model"), modelMetric != null],
                ] as const
              ).map(
                ([group, label, visible]) =>
                  visible && (
                    <button
                      key={group}
                      type="button"
                      aria-pressed={mode === group}
                      className={toggleClass(mode === group)}
                      onClick={() => {
                        setPreviewKey(undefined);
                        setGroupBy(group);
                      }}
                    >
                      {label}
                    </button>
                  ),
              )}
            </div>
          )}
          <div
            role="group"
            aria-label={t("usage.display.trendChartType")}
            className="inline-flex gap-0.5 rounded-[8px] bg-subtle p-0.5"
          >
            <button
              type="button"
              aria-pressed={showHeatmap}
              className={toggleClass(showHeatmap)}
              onClick={() => {
                setPreviewKey(undefined);
                setShowHeatmap(true);
              }}
            >
              {t("usage.heatmap.toggle")}
            </button>
            {[...TREND_CHART_TYPES].reverse().map((type) => (
              <button
                key={type}
                type="button"
                aria-pressed={!showHeatmap && chartType === type}
                disabled={savingChartType}
                className={toggleClass(!showHeatmap && chartType === type)}
                onClick={() => {
                  if (chartType !== type) void changeChartType(type);
                  else {
                    setPreviewKey(undefined);
                    setShowHeatmap(false);
                  }
                }}
              >
                {t(`usage.display.trendChartTypes.${type}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {legend.length > 0 && (
        <ul
          data-testid="usage-trend-legend"
          className="m-0 mt-2 flex flex-wrap gap-x-4 gap-y-1 p-0 text-caption text-fg-2"
        >
          {legend.map(({ key, name, color }) => (
            <li key={key} className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-[2px]"
                style={{ background: color }}
              />
              <span className="min-w-0 break-words">{name}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 grid grid-cols-1 gap-4 [@container(min-width:700px)]:grid-cols-[minmax(0,1fr)_clamp(205px,27%,275px)]">
        <div
          ref={chartBoxRef}
          className="min-w-0"
          style={{
            minHeight: isLoading || !showHeatmap ? CHART_HEIGHT : undefined,
          }}
        >
          {isLoading ? (
            <div
              className="flex items-center justify-center"
              style={{ height: CHART_HEIGHT }}
            >
              <Loader2 className="h-5 w-5 animate-spin text-fg-3" />
            </div>
          ) : showHeatmap ? (
            <UsageHeatmap
              points={chartData}
              metric={metric}
              locale={dateLocale}
              activeKey={activePoint?.xKey}
              formatValue={formatSummary}
              onPreview={setPreviewKey}
              onSelect={pinInterval}
            />
          ) : (
            <Chart
              width={chartWidth}
              height={CHART_HEIGHT}
              data={chartData}
              accessibilityLayer={false}
              margin={{ top: 6, right: 10, left: 0, bottom: 0 }}
              onMouseMove={({ activeLabel, isTooltipActive }) => {
                setPreviewKey(
                  isTooltipActive && typeof activeLabel === "string"
                    ? activeLabel
                    : undefined,
                );
              }}
              onMouseLeave={() => setPreviewKey(undefined)}
              onClick={({ activeLabel, isTooltipActive }) => {
                if (isTooltipActive && typeof activeLabel === "string") {
                  pinInterval(activeLabel);
                }
              }}
            >
              <CartesianGrid
                vertical={false}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              {/* 🔴 分类键必须是后端 RFC3339 桶时间戳（xKey），不能用显示文字，否则跨年错位 */}
              <XAxis
                dataKey="xKey"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickMargin={6}
                minTickGap={12}
                tickFormatter={(value) =>
                  formatUsageTrendTickLabel(String(value), chartData)
                }
                allowDuplicatedCategory={false}
              />
              <YAxis
                width="auto"
                axisLine={false}
                tickLine={false}
                tick={AXIS_TICK}
                tickCount={4}
                domain={metric === "hitRate" ? [hitRateFloor, 1] : undefined}
                tickFormatter={formatYTick}
              />
              <Tooltip content={() => null} cursor={false} />
              {activePoint && (
                <ReferenceLine
                  x={activePoint.xKey}
                  stroke="var(--text-3)"
                  strokeDasharray="3 3"
                />
              )}
              {plotSeries.map(({ key, name, color, value: valueOf }) => {
                const stackId =
                  key !== "total" && metric !== "hitRate" ? "usage" : undefined;
                const dataKey = (point: UsageTrendChartPoint) => {
                  const value = valueOf(point);
                  if (value == null) return stackId ? 0 : null;
                  return metric === "cost" ? value * rate : value;
                };
                return chartType === "bar" ? (
                  <Bar
                    key={key}
                    dataKey={dataKey}
                    name={name}
                    stackId={stackId}
                    fill={color}
                    radius={stackId ? undefined : [3, 3, 0, 0]}
                    maxBarSize={36}
                    isAnimationActive={false}
                  />
                ) : (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={dataKey}
                    name={name}
                    stroke={color}
                    strokeWidth={2}
                    dot={
                      chartData.length <= 14
                        ? { r: 2.5, strokeWidth: 0, fill: color }
                        : false
                    }
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                );
              })}
            </Chart>
          )}
        </div>
        <aside
          aria-label={t("usage.tabs.label")}
          className="min-w-0 self-start rounded-[8px] border border-border bg-subtle p-3"
        >
          {activePoint ? (
            <>
              <label className="relative block text-caption text-fg-2">
                <span className="sr-only">{t("usage.time")}</span>
                <select
                  className="w-full appearance-none truncate rounded-[4px] bg-transparent pe-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={activePoint.xKey}
                  onChange={(event) => pinInterval(event.currentTarget.value)}
                >
                  {intervalOptions.map(({ xKey, label }) => (
                    <option key={xKey} value={xKey}>
                      {label}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute end-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                />
              </label>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
                <span className="text-caption text-fg-2">
                  {metric === "hitRate" ? metricLabel : t("usage.detail.total")}
                </span>
                <strong className="min-w-0 break-all text-xl font-semibold text-fg-1">
                  {formatSummary(activeValue)}
                </strong>
              </div>
              {breakdown.length > 0 && (
                <ul
                  aria-label={t(showModels ? "usage.model" : "usage.app")}
                  className="m-0 mt-2.5 border-t border-border p-0"
                >
                  {breakdown.map(({ key, name, color, value }) => {
                    const showShare =
                      metric !== "hitRate" &&
                      value != null &&
                      activeValue != null &&
                      activeValue > 0;
                    return (
                      <li
                        key={key}
                        className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 border-b border-border py-1.5 text-caption tabular-nums last:border-b-0"
                      >
                        <span className="flex min-w-0 items-center gap-2 text-fg-1">
                          <span
                            aria-hidden="true"
                            className="h-0.5 w-2.5 shrink-0 rounded-full"
                            style={{ background: color }}
                          />
                          <span className="min-w-0 break-words">{name}</span>
                        </span>
                        <span className="flex items-baseline justify-end gap-2 text-end text-fg-1">
                          {formatSummary(value)}
                          {showShare && (
                            <span className="min-w-[3.5em] text-fg-3">
                              {percentage.format(value / activeValue)}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : (
            <p className="m-0 text-caption text-fg-3">
              {isLoading ? t("common.loading") : t("usage.noData")}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}
