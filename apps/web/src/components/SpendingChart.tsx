import { BarChart, PieChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { createEffect, onCleanup, onMount } from "solid-js";
import type { LocalExpense } from "../lib/db";

echarts.use([BarChart, PieChart, GridComponent, TooltipComponent, SVGRenderer]);

interface SpendingChartProps {
  expenses: LocalExpense[];
  currency: string;
  mode: "category" | "month";
}

const palette = ["#0f9f77", "#5d7cf6", "#f59e55", "#d95f89", "#8b72d8", "#56a7d8", "#7ab86d"];

function money(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(value / 100);
}

export function SpendingChart(props: SpendingChartProps) {
  let root!: HTMLDivElement;
  let chart: echarts.ECharts | undefined;

  function render(): void {
    if (!chart) return;
    const expenses = props.expenses.filter((expense) => expense.status === "active" && expense.currency === props.currency);
    if (props.mode === "category") {
      const totals = new Map<string, number>();
      for (const expense of expenses) totals.set(expense.category, (totals.get(expense.category) ?? 0) + expense.amountMinor);
      chart.setOption({
        animationDuration: 450,
        color: palette,
        tooltip: { trigger: "item", formatter: (item: { name: string; value: number; percent: number }) => `${item.name}<br/><strong>${money(item.value, props.currency)}</strong> · ${item.percent}%` },
        series: [{ type: "pie", radius: ["58%", "82%"], center: ["50%", "51%"], avoidLabelOverlap: true, padAngle: 3, itemStyle: { borderRadius: 7 }, label: { show: false }, emphasis: { scaleSize: 5 }, data: [...totals].sort((a, b) => b[1] - a[1]).map(([name, value]) => ({ name, value })) }],
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
      color: [palette[0]!],
      grid: { top: 12, right: 4, bottom: 26, left: 4, containLabel: true },
      tooltip: { trigger: "axis", formatter: (items: Array<{ axisValue: string; value: number }>) => `${items[0]?.axisValue ?? ""}<br/><strong>${money(items[0]?.value ?? 0, props.currency)}</strong>` },
      xAxis: { type: "category", data: entries.map(([key]) => new Intl.DateTimeFormat(undefined, { month: "short" }).format(new Date(`${key}-15T12:00:00`))), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: "#7b7b82", fontSize: 11 } },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "rgba(120,120,128,.12)" } }, axisLabel: { show: false } },
      series: [{ type: "bar", data: entries.map(([, value]) => value), barMaxWidth: 28, itemStyle: { borderRadius: [7, 7, 3, 3] } }],
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
