import type { ComponentProps, ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createTestQueryClient,
  renderWithQueryClient as render,
} from "../utils/testQueryClient";
import { describe, expect, it, vi } from "vitest";
import { UsageTrendChart } from "@/components/usage/UsageTrendChart";

vi.mock("recharts", async (importOriginal) => {
  const recharts = await importOriginal<typeof import("recharts")>();
  return {
    ...recharts,
    // jsdom has no layout; keep the actual charts with fixed dimensions.
    LineChart: (props: ComponentProps<typeof recharts.LineChart>) => (
      <recharts.LineChart
        {...props}
        responsive={false}
        width={640}
        height={132}
      />
    ),
    BarChart: (props: ComponentProps<typeof recharts.BarChart>) => (
      <recharts.BarChart
        {...props}
        responsive={false}
        width={640}
        height={132}
      />
    ),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

const { fixture } = vi.hoisted(() => ({
  fixture: {
    mixed: false,
    secondInterval: false,
    firstDate: null as string | null,
  },
}));

vi.mock("@/lib/query/usage", () => ({
  useUsageFirstDate: () => ({ data: fixture.firstDate, isLoading: false }),
  useUsageTrends: () => ({
    data: [
      {
        date: "2026-09-30T00:00:00Z",
        requestCount: 12,
        totalInputTokens: fixture.mixed ? 25 : 100,
        totalOutputTokens: fixture.mixed ? 55 : 50,
        totalCacheCreationTokens: 0,
        totalCacheReadTokens: fixture.mixed ? 70 : 0,
        totalCost: "0.01",
        ...(fixture.mixed && {
          runtimeStats: [
            {
              appType: "claude",
              requestCount: 8,
              totalInputTokens: 15,
              totalOutputTokens: 45,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 60,
              totalCost: "0.008",
            },
            {
              appType: "dsh",
              requestCount: 4,
              totalInputTokens: 10,
              totalOutputTokens: 10,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 10,
              totalCost: "0.002",
            },
          ],
        }),
      },
      ...(fixture.secondInterval
        ? [
            {
              date: "2026-10-01T00:00:00Z",
              requestCount: 5,
              totalInputTokens: 200,
              totalOutputTokens: 100,
              totalCacheCreationTokens: 0,
              totalCacheReadTokens: 0,
              totalCost: "0.02",
            },
          ]
        : []),
    ],
    isLoading: false,
  }),
}));

describe("UsageTrendChart (single metric)", () => {
  it("titles the chart with the metric picked on the metric strip", () => {
    const { rerender } = render(
      <UsageTrendChart
        range={{ preset: "7d" }}
        metric="tokens"
        refreshIntervalMs={0}
      />,
    );
    // 图表自己不再有指标切换和单系列图例：指标由上方指标条选
    expect(
      screen.getByRole("heading", { name: "usage.trend.titleMetric" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("usage-trend-legend")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "usage.trend.cost" }),
    ).not.toBeInTheDocument();

    rerender(
      <UsageTrendChart
        range={{ preset: "7d" }}
        metric="hitRate"
        refreshIntervalMs={0}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "usage.trend.titleMetric" }),
    ).toBeInTheDocument();
  });
});

describe("UsageTrendChart styles", () => {
  const renderWithChartType = (
    trendChartType?: string,
    metric: "cost" | "requests" | "tokens" | "hitRate" = "tokens",
    onChartTypeChange?: ComponentProps<
      typeof UsageTrendChart
    >["onChartTypeChange"],
  ) => {
    const props = {
      range: {
        preset: "custom" as const,
        customStartDate: Date.parse("2026-09-30T00:00:00Z") / 1000,
        customEndDate: Date.parse("2026-10-06T12:00:00Z") / 1000,
      },
      metric,
      refreshIntervalMs: 0,
      onChartTypeChange,
    };
    const client = createTestQueryClient();
    // 不让挂载时的重新拉取用 mock 后端的默认设置覆盖掉这里给的值
    client.setDefaultOptions({
      queries: { retry: false, staleTime: Infinity },
    });
    client.setQueryData(["settings"], { usageDisplay: { trendChartType } });
    return rtlRender(<UsageTrendChart {...props} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  };

  it("switches between bars and curves and saves the chart style", async () => {
    const user = userEvent.setup();
    const save = vi.fn().mockResolvedValue(true);
    const { container } = renderWithChartType(undefined, "tokens", save);
    const bar = screen.getByRole("button", {
      name: "usage.display.trendChartTypes.bar",
    });
    const area = screen.getByRole("button", {
      name: "usage.display.trendChartTypes.area",
    });
    expect(bar).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".recharts-bar-rectangle")).not.toBeNull();
    expect(container.querySelector(".recharts-line")).toBeNull();

    await user.click(area);

    expect(save).toHaveBeenNthCalledWith(1, "area");
    expect(area).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".recharts-line")).not.toBeNull();
    expect(container.querySelector(".recharts-bar-rectangle")).toBeNull();

    await user.click(bar);

    expect(save).toHaveBeenNthCalledWith(2, "bar");
    expect(bar).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector(".recharts-bar-rectangle")).not.toBeNull();
  });

  it.each(["tokens", "requests", "cost", "hitRate"] as const)(
    "draws the saved line style for the %s metric",
    (metric) => {
      const { container } = renderWithChartType("area", metric);
      expect(container.querySelector(".recharts-line")).not.toBeNull();
      // A one-bucket range must still show a point in line mode.
      expect(container.querySelector(".recharts-line-dot")).not.toBeNull();
      expect(container.querySelector(".recharts-bar-rectangle")).toBeNull();
    },
  );

  it("stacks actual token contributions and labels the runtime colors", () => {
    fixture.mixed = true;
    try {
      const { container } = renderWithChartType();
      const legend = screen.getByTestId("usage-trend-legend");
      expect(legend).toHaveTextContent("Claude Code");
      expect(legend).toHaveTextContent("DeepSeek Harness");
      const colors = ["var(--agent-claude)", "var(--heat-app-dsh)"];
      const bars = colors.map(
        (color) =>
          container.querySelector(`.recharts-rectangle[fill="${color}"]`)!,
      );
      const [claude, dsh] = bars.map((bar) =>
        Number(bar.getAttribute("height")),
      );
      expect(dsh).toBeGreaterThan(0);
      expect(claude / dsh).toBeCloseTo(4);
      expect(bars[0].getAttribute("x")).toBe(bars[1].getAttribute("x"));
    } finally {
      fixture.mixed = false;
    }
  });

  it("shows the latest interval and lets the user pin an earlier breakdown", async () => {
    fixture.mixed = true;
    fixture.secondInterval = true;
    try {
      const user = userEvent.setup();
      renderWithChartType("area", "cost");
      const details = within(
        screen.getByRole("complementary", { name: "usage.tabs.label" }),
      );
      const interval = details.getByRole("combobox", { name: "usage.time" });
      expect(interval).toHaveValue("2026-10-01T00:00:00Z");
      expect(details.getByText("$0.02")).toBeInTheDocument();

      await user.selectOptions(interval, "2026-09-30T00:00:00Z");

      expect(details.getByText("$0.01")).toBeInTheDocument();
      expect(details.getByText("Claude Code")).toBeInTheDocument();
      expect(details.getByText("80%")).toBeInTheDocument();
      expect(details.getByText("DeepSeek Harness")).toBeInTheDocument();
      expect(details.getByText("20%")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "usage.heatmap.toggle" }),
      );

      expect(interval).toHaveValue("2026-09-30T00:00:00Z");
      const later = screen.getByRole("button", { name: /\$0\.02/ });
      await user.hover(later);
      expect(interval).toHaveValue("2026-10-01T00:00:00Z");
      await user.unhover(later);
      expect(interval).toHaveValue("2026-09-30T00:00:00Z");

      await user.click(later);
      await user.click(
        screen.getByRole("button", {
          name: "usage.display.trendChartTypes.bar",
        }),
      );
      expect(interval).toHaveValue("2026-10-01T00:00:00Z");
    } finally {
      fixture.mixed = false;
      fixture.secondInterval = false;
    }
  });

  it("opens All on Heatmap and keeps the same range when switching to Line", async () => {
    fixture.firstDate = "2026-09-30";
    try {
      const user = userEvent.setup();
      render(
        <UsageTrendChart
          range={{ preset: "all" }}
          metric="cost"
          refreshIntervalMs={0}
        />,
      );
      expect(
        screen.getByRole("button", { name: "usage.heatmap.toggle" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.getByRole("button", { name: /\$0\.01/ }),
      ).toBeInTheDocument();
      const line = screen.getByRole("button", {
        name: "usage.display.trendChartTypes.area",
      });
      await user.click(line);
      expect(line).toHaveAttribute("aria-pressed", "true");
      expect(
        screen.queryByRole("button", { name: /\$0\.01/ }),
      ).not.toBeInTheDocument();
    } finally {
      fixture.firstDate = null;
    }
  });

  it("shows each app's cache hit rate without additive shares", () => {
    fixture.mixed = true;
    try {
      renderWithChartType("area", "hitRate");
      const details = within(
        screen.getByRole("complementary", { name: "usage.tabs.label" }),
      );
      expect(details.getByText("73.7%")).toBeInTheDocument();
      expect(details.getByText("80.0%")).toBeInTheDocument();
      expect(details.getByText("50.0%")).toBeInTheDocument();
      expect(details.getAllByText(/%$/)).toHaveLength(3);
    } finally {
      fixture.mixed = false;
    }
  });

  it("compares individual cache hit rates without stacking percentages", () => {
    fixture.mixed = true;
    try {
      const { container } = renderWithChartType(undefined, "hitRate");
      const claude = container.querySelector(
        '.recharts-rectangle[fill="var(--agent-claude)"]',
      )!;
      const dsh = container.querySelector(
        '.recharts-rectangle[fill="var(--heat-app-dsh)"]',
      )!;
      // Bars at different positions in the same bucket, sharing a baseline.
      expect(claude.getAttribute("x")).not.toBe(dsh.getAttribute("x"));
      const baseline = (bar: Element) =>
        Number(bar.getAttribute("y")) + Number(bar.getAttribute("height"));
      expect(baseline(claude)).toBeCloseTo(baseline(dsh));
    } finally {
      fixture.mixed = false;
    }
  });

  it("falls back to a bar chart for an unknown saved style", () => {
    const { container } = renderWithChartType("unknown");
    expect(container.querySelector(".recharts-bar-rectangle")).not.toBeNull();
    expect(container.querySelector(".recharts-line")).toBeNull();
  });
});
