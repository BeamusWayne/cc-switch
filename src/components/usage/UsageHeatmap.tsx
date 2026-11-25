import { useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { UsageMetric } from "./rememberedChoice";
import { runtimeColor } from "./runtimePalette";
import type { UsageTrendChartPoint } from "./UsageTrendChart";

const WEEKS_PER_GRID = 53;
const HEAT_LEVELS = [0, 1, 2, 3, 4];

interface UsageHeatmapProps {
  points: UsageTrendChartPoint[];
  metric: UsageMetric;
  locale: string;
  activeKey?: string;
  formatValue: (value: number | null) => string;
  onPreview: (key?: string) => void;
  onSelect: (key: string) => void;
}

function dominantApp(point: UsageTrendChartPoint, metric: UsageMetric) {
  let app: string | undefined;
  let largest = 0;
  for (const [name, stats] of Object.entries(point.runtimeStats)) {
    const value =
      metric === "hitRate" ? stats.cacheableInput : (stats[metric] ?? 0);
    if (value > largest || (value === largest && app && name < app)) {
      app = name;
      largest = value;
    }
  }
  return app;
}

function heatFill(level: number, color?: string): CSSProperties {
  return {
    "--heat-fill": color
      ? `color-mix(in srgb, ${color} var(--heat-strength-${level}), transparent)`
      : `var(--heat-${level})`,
  } as CSSProperties;
}

export function UsageHeatmap({
  points,
  metric,
  locale,
  activeKey,
  formatValue,
  onPreview,
  onSelect,
}: UsageHeatmapProps) {
  const { t } = useTranslation();
  const [showEarlier, setShowEarlier] = useState(false);
  const { cells, thresholds } = useMemo(() => {
    const cells = points.map((point) => ({
      key: point.xKey,
      date: new Date(point.rawDate),
      value: point[metric],
      hasActivity: point.requests > 0,
      app: dominantApp(point, metric),
    }));
    const values = cells
      .flatMap(({ value, hasActivity }) =>
        hasActivity && value != null ? [value] : [],
      )
      .sort((a, b) => a - b);
    const thresholds = [0.25, 0.5, 0.75].map(
      (part) => values[Math.floor((values.length - 1) * part)] ?? Infinity,
    );
    return { cells, thresholds };
  }, [points, metric]);

  const shortDay = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
    [locale],
  );
  const fullDay = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "full" }),
    [locale],
  );
  const weekday = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short" }),
    [locale],
  );
  const month = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: "short" }),
    [locale],
  );

  if (!cells.length) {
    return (
      <p className="m-0 py-5 text-caption text-fg-3">{t("usage.noData")}</p>
    );
  }

  const strip = cells.length <= 14;
  const firstWeekday = (cells[0].date.getDay() + 6) % 7;
  const weekCount = Math.ceil((firstWeekday + cells.length) / 7);
  const latestWeek = Math.max(0, weekCount - WEEKS_PER_GRID);
  const latestIndex = Math.max(0, latestWeek * 7 - firstWeekday);
  const earlierSelected = cells
    .slice(0, latestIndex)
    .some(({ key }) => key === activeKey);
  const expanded = showEarlier || earlierSelected;
  const gridCount = expanded ? Math.ceil(weekCount / WEEKS_PER_GRID) : 1;

  const renderCell = (cell: (typeof cells)[number], style?: CSSProperties) => {
    const { key, date, value, hasActivity, app } = cell;
    const level =
      hasActivity && value != null
        ? 1 + thresholds.filter((limit) => value > limit).length
        : 0;
    const fill = cn(
      level > 0 ? "usage-heat-fill" : "bg-subtle",
      key === activeKey &&
        "ring-1 ring-ring ring-offset-1 ring-offset-background",
    );
    const color = level
      ? heatFill(level, app ? runtimeColor(app) : undefined)
      : undefined;
    const label = formatValue(value);
    const events = {
      onMouseEnter: () => onPreview(key),
      onMouseLeave: () => onPreview(),
      onClick: () => onSelect(key),
    };
    return strip ? (
      <button
        type="button"
        key={key}
        aria-label={`${fullDay.format(date)} · ${label}`}
        aria-pressed={key === activeKey}
        className={cn(
          "grid min-w-0 gap-1 rounded-[4px] py-1 text-center text-caption tabular-nums text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          key === activeKey && "font-semibold text-fg-1",
        )}
        {...events}
      >
        <span>{shortDay.format(date)}</span>
        <span
          aria-hidden="true"
          className={cn("h-[22px] rounded-[4px]", fill)}
          style={color}
        />
        <span className="truncate">{label}</span>
      </button>
    ) : (
      <button
        type="button"
        key={key}
        aria-label={`${fullDay.format(date)} · ${label}`}
        aria-pressed={key === activeKey}
        className={cn(
          "aspect-square w-full rounded-[3px] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          fill,
        )}
        style={{ ...style, ...color }}
        {...events}
      />
    );
  };

  return (
    <div className="min-w-0">
      {strip ? (
        <div
          className="grid gap-x-2 gap-y-1"
          style={{
            gridTemplateColumns: `repeat(${Math.min(7, cells.length)}, minmax(0, 1fr))`,
            maxWidth: Math.min(7, cells.length) * 90,
          }}
        >
          {cells.map((cell) => renderCell(cell))}
        </div>
      ) : (
        <div className="space-y-3 overflow-x-auto p-0.5">
          {Array.from({ length: gridCount }, (_, index) => {
            const lastWeek = weekCount - index * WEEKS_PER_GRID;
            const startWeek = Math.max(0, lastWeek - WEEKS_PER_GRID);
            const startIndex = Math.max(0, startWeek * 7 - firstWeekday);
            const span = cells.slice(startIndex, lastWeek * 7 - firstWeekday);
            let lastLabelColumn = -2;
            let previousMonth = -1;
            return (
              <div
                key={startWeek}
                className="grid items-center gap-[3px]"
                style={{
                  gridTemplateColumns: `max-content repeat(${lastWeek - startWeek}, minmax(8px, 18px))`,
                }}
              >
                {[0, 2, 4, 6].map((day) => (
                  <span
                    key={day}
                    className="pe-1 text-badge leading-none text-fg-3"
                    style={{ gridColumn: 1, gridRow: day + 2 }}
                  >
                    {weekday.format(new Date(2024, 0, 1 + day))}
                  </span>
                ))}
                {span.map((cell, offset) => {
                  const position = startIndex + offset + firstWeekday;
                  const column = 2 + Math.floor(position / 7) - startWeek;
                  const currentMonth = cell.date.getMonth();
                  const labelMonth =
                    currentMonth !== previousMonth &&
                    column - lastLabelColumn >= 3;
                  if (labelMonth) lastLabelColumn = column;
                  previousMonth = currentMonth;
                  return [
                    labelMonth && (
                      <span
                        key={`${cell.key}-month`}
                        className="whitespace-nowrap text-badge text-fg-3"
                        style={{ gridColumn: column, gridRow: 1 }}
                      >
                        {month.format(cell.date)}
                        {offset === 0 && gridCount > 1
                          ? ` ${cell.date.getFullYear()}`
                          : ""}
                      </span>
                    ),
                    renderCell(cell, {
                      gridColumn: column,
                      gridRow: 2 + (position % 7),
                    }),
                  ];
                })}
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-1.5 gap-y-2 text-badge text-fg-3">
        {latestWeek > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            className="me-auto rounded-[4px] text-caption text-fg-2 hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              if (earlierSelected) onSelect(cells[latestIndex].key);
              setShowEarlier(!expanded);
            }}
          >
            {t(expanded ? "usage.heatmap.showLess" : "usage.heatmap.showMore")}
          </button>
        )}
        {t("usage.heatmap.less")}
        {HEAT_LEVELS.map((level) => (
          <span
            key={level}
            className={cn(
              "h-2.5 w-2.5 rounded-[2px]",
              level ? "usage-heat-fill" : "bg-subtle",
            )}
            aria-hidden="true"
            style={level ? heatFill(level, "var(--text-2)") : undefined}
          />
        ))}
        {t("usage.heatmap.more")}
      </div>
    </div>
  );
}
