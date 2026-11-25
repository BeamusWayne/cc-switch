import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageHeatmap } from "@/components/usage/UsageHeatmap";
import { buildUsageTrendChartData } from "@/components/usage/UsageTrendChart";
import type { DailyStats } from "@/types/usage";

function day(
  dayOfMonth: number,
  apps: [appType: string, requests: number, cost?: number][] = [],
): DailyStats {
  const runtimeStats = apps.map(([appType, requests, cost = 0]) => ({
    appType,
    requestCount: requests,
    totalCost: String(cost),
    totalInputTokens: requests * 10,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
  }));
  const requestCount = apps.reduce((sum, [, requests]) => sum + requests, 0);
  return {
    date: new Date(2025, 5, dayOfMonth).toISOString(),
    runtimeStats,
    requestCount,
    totalTokens: requestCount * 10,
    totalCost: String(apps.reduce((sum, [, , cost = 0]) => sum + cost, 0)),
    totalInputTokens: requestCount * 10,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
  };
}

function props(rows: DailyStats[]) {
  return {
    points: buildUsageTrendChartData(rows, {
      isHourly: false,
      dateLocale: "en-US",
      startDate: Date.parse(rows[0].date) / 1000,
      endDate: Date.parse(rows[rows.length - 1].date) / 1000,
    }),
    locale: "en-US",
    formatValue: (value: number | null) => String(value ?? "—"),
    onPreview: vi.fn(),
    onSelect: vi.fn(),
  };
}

function fill(cell: HTMLElement) {
  return cell
    .querySelector<HTMLElement>(".usage-heat-fill")
    ?.style.getPropertyValue("--heat-fill");
}

describe("UsageHeatmap", () => {
  it("uses one horizontal cell per day and shades the day's largest app by the active metric", () => {
    const rows = [
      day(1, [["claude", 1, 1]]),
      day(2, [["codex", 1, 2]]),
      day(3, [
        ["claude", 8, 2],
        ["codex", 2, 8],
      ]),
      day(4),
    ];
    const heatmapProps = props(rows);
    const { rerender } = render(
      <UsageHeatmap {...heatmapProps} metric="requests" />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    expect(buttons[0].parentElement).toHaveStyle({
      gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    });
    expect(fill(buttons[0])).toContain(
      "var(--agent-claude) var(--heat-strength-1)",
    );
    expect(fill(buttons[2])).toContain(
      "var(--agent-claude) var(--heat-strength-4)",
    );
    expect(fill(buttons[3])).toBeUndefined();

    rerender(<UsageHeatmap {...heatmapProps} metric="cost" />);
    expect(fill(buttons[2])).toContain(
      "var(--agent-codex) var(--heat-strength-4)",
    );
  });

  it("keeps the first day in its weekday column without clickable padding", () => {
    const rows = Array.from({ length: 17 }, (_, index) => day(index + 1));
    const heatmapProps = props(rows);
    render(
      <UsageHeatmap
        {...heatmapProps}
        metric="tokens"
        activeKey={rows[0].date}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(17);
    // June 1 was a Sunday, so the visible calendar starts at the bottom of week one.
    expect(buttons[0]).toHaveStyle({ gridColumn: "2", gridRow: "8" });
    expect(buttons[1]).toHaveStyle({ gridColumn: "3", gridRow: "2" });
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");

    fireEvent.mouseEnter(buttons[1]);
    expect(heatmapProps.onPreview).toHaveBeenLastCalledWith(rows[1].date);
    fireEvent.mouseLeave(buttons[1]);
    expect(heatmapProps.onPreview).toHaveBeenLastCalledWith();
    fireEvent.click(buttons[1]);
    expect(heatmapProps.onSelect).toHaveBeenLastCalledWith(rows[1].date);
  });
});
