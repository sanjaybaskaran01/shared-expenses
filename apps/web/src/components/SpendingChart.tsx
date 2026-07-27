import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { createEffect, onCleanup, onMount } from "solid-js";
import type { LocalExpense } from "../lib/db";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, SVGRenderer]);

interface SpendingChartProps {
  expenses: LocalExpense[];
  currency: string;
  mode: "category" | "month";
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value / 100);
}

export function SpendingChart(props: SpendingChartProps) {
  let root!: HTMLDivElement;
  let chart: echarts.ECharts | undefined;

  function render(): void {
    if (!chart) return;
    const expenses = props.expenses.filter((expense) => expense.status === "active" && expense.currency === props.currency);
    const styles = getComputedStyle(document.documentElement);
    const ink = styles.getPropertyValue("--chart-ink").trim() || "#21201c";
    const accent = styles.getPropertyValue("--chart-accent").trim() || "#208368";
    const muted = styles.getPropertyValue("--muted-foreground").trim() || "#63635e";
    const gridLine = styles.getPropertyValue("--chart-grid").trim() || "rgba(32,41,76,.1)";
    const tooltip = { backgroundColor: styles.getPropertyValue("--card").trim(), borderColor: gridLine, textStyle: { color: styles.getPropertyValue("--foreground").trim(), fontSize: 12 }, extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(18,22,20,.12);" };
    if (props.mode === "category") {
      const totals = new Map<string, number>();
      for (const expense of expenses) totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountMinor);
      const entries = [...totals].sort((left, right) => left[1] - right[1]).slice(-6);
      chart.setOption({
        animationDuration: 450,
        grid: { top: 4, right: 58, bottom: 4, left: 4, containLabel: true },
        tooltip: { ...tooltip, trigger: "item", formatter: (item: { name: string; value: number }) => `${item.name}<br/><strong>${money(item.value, props.currency)}</strong>` },
        xAxis: { type: "value", show: false },
        yAxis: { type: "category", data: entries.map(([name]) => name), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 11, width: 82, overflow: "truncate" } },
        series: [{ type: "bar", data: entries.map(([, value], index) => ({ value, itemStyle: { color: index === entries.length - 1 ? accent : ink } })), barWidth: 10, itemStyle: { borderRadius: 8 }, label: { show: true, position: "right", color: muted, fontSize: 10, formatter: (item: { value: number }) => money(item.value, props.currency) } }],
      }, true);
      return;
    }
    const totals = new Map<string, number>();
    for (const expense of expenses) {
      const key = expense.expenseDate.slice(0, 7);
      totals.set(key, (totals.get(key) ?? 0) + expense.amountMinor);
    }
    const entries = [...totals].sort(([left], [right]) => left.localeCompare(right)).slice(-6);
    chart.setOption({
      animationDuration: 450,
      grid: { top: 18, right: 12, bottom: 26, left: 8, containLabel: true },
      tooltip: { ...tooltip, trigger: "axis", axisPointer: { type: "line", lineStyle: { color: accent, width: 1 } }, formatter: (items: Array<{ axisValue: string; value: number }>) => `${items[0]?.axisValue ?? ""}<br/><strong>${money(items[0]?.value ?? 0, props.currency)}</strong>` },
      xAxis: { type: "category", boundaryGap: false, data: entries.map(([key]) => new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(`${key}-15T12:00:00`))), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: muted, fontSize: 11 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: gridLine } }, axisLabel: { show: false } },
      series: [{ type: "line", smooth: .35, data: entries.map(([, value]) => value), symbol: "circle", symbolSize: 7, showSymbol: true, lineStyle: { color: ink, width: 2.5 }, itemStyle: { color: accent, borderColor: ink, borderWidth: 2 }, emphasis: { focus: "series", scale: 1.35 } }],
    }, true);
  }

  onMount(() => {
    chart = echarts.init(root, undefined, { renderer: "svg" });
    render();
    const observer = new ResizeObserver(() => chart?.resize());
    observer.observe(root);
    onCleanup(() => { observer.disconnect(); chart?.dispose(); });
  });
  createEffect(render);

  return <div ref={root} class="h-52 w-full" role="img" aria-label={`${props.mode === "category" ? "Spending by category" : "Monthly spending"} chart`} />;
}
