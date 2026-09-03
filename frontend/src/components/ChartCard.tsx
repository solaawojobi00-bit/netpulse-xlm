import type { ReactNode } from "react";

export type ChartStatus = "loading" | "error" | "empty" | "ready";

/*
 * Status precedence, and why it is this order:
 *
 *   ready > error > loading > empty
 *
 * `ready` wins even when the source is currently erroring, because the six
 * live charts share one WebSocket subscription. Blanking all of them on a
 * dropped connection would throw away data that is seconds old and replace it
 * with six identical error boxes, while the global banner already says the
 * backend is unreachable. Showing the last known series is both more useful
 * and quieter.
 *
 * So a per-chart error appears only when there is nothing to fall back on —
 * a cold start that never succeeded — which is exactly when an empty axis
 * frame would otherwise be indistinguishable from a quiet network.
 */
export function resolveChartStatus(
  data: readonly unknown[] | null | undefined,
  error?: string | null,
): ChartStatus {
  if (data && data.length > 0) return "ready";
  if (error) return "error";
  if (data === null || data === undefined) return "loading";
  return "empty";
}

interface ChartCardProps {
  title: string;
  status: ChartStatus;
  children: ReactNode;
  /** Shown when loaded with genuinely nothing to display. */
  emptyMessage?: string;
  /** Shown when the source failed and no earlier data exists. */
  errorMessage?: string;
  /** Extra header content, e.g. the Soroban card's stat pills. */
  headerExtra?: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  /**
   * Sentence describing the plotted data, including its current values. It
   * becomes the chart's accessible name, and it is the only thing a screen
   * reader gets from a chart — the SVG beneath conveys nothing. Build it with
   * the helpers in `chartSummary.ts` rather than by hand.
   */
  summary?: string | null;
  /**
   * Heading level for the card title. Chart cards sit under a section heading,
   * so h3 is right in the default layout; HistoryView nests them one deeper.
   */
  titleLevel?: 3 | 4;
}

/**
 * One place that decides how a chart looks while loading, empty, or failed,
 * so the seven call sites do not each grow their own conditional block.
 *
 * Every state renders inside a fixed-height box matching the chart's own
 * height, so switching between them does not move the rest of the page.
 */
export function ChartCard({
  title,
  status,
  children,
  emptyMessage = "No data in this window.",
  errorMessage = "Could not load this data.",
  headerExtra,
  subtitle,
  className = "",
  summary,
  titleLevel = 3,
}: ChartCardProps) {
  const Heading = titleLevel === 4 ? "h4" : "h3";

  return (
    <div className={`chart-card ${className}`.trim()}>
      {headerExtra || subtitle ? (
        <div className="chart-card__header">
          <div>
            <Heading>{title}</Heading>
            {subtitle}
          </div>
          {headerExtra}
        </div>
      ) : (
        <Heading>{title}</Heading>
      )}

      {/*
       * `role="img"` collapses the SVG's hundreds of meaningless <path>
       * children into a single node named by the summary, which is both what a
       * screen reader can act on and far less noisy than letting it walk the
       * chart internals. Without this the whole card announces as nothing.
       */}
      {status === "ready" && (
        <div role="img" aria-label={summary ? `${title}. ${summary}` : title}>
          {children}
        </div>
      )}

      {status === "loading" && (
        <div className="chart-card__state" role="status" aria-label={`${title}: loading`}>
          <div className="chart-skeleton" aria-hidden="true">
            {[68, 42, 84, 55, 73, 38].map((height, i) => (
              <span
                key={i}
                className="chart-skeleton__bar"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </div>
      )}

      {status === "empty" && (
        <div className="chart-card__state chart-card__state--empty">
          <p className="chart-card__state-text">{emptyMessage}</p>
        </div>
      )}

      {/*
       * Two-layer error model:
       *
       *   global banner — announces the cause once ("backend unreachable")
       *   chart state   — says which data is missing, so an empty axis frame
       *                   is never mistaken for a quiet network
       *
       * The banner is the announcement; these are labels. One outage can put
       * this state on all seven cards, so marking each `role="alert"` would
       * fire seven assertive interruptions for a single cause. They are
       * polite status regions instead, and the text names the data source
       * rather than restating why it failed.
       */}
      {status === "error" && (
        <div
          className="chart-card__state chart-card__state--error"
          role="status"
          aria-label={`${title}: unavailable`}
        >
          <p className="chart-card__state-text">{errorMessage}</p>
        </div>
      )}
    </div>
  );
}
