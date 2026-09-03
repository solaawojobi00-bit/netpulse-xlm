/*
 * The network selector's markup, generalised so the history range picker does
 * not grow a second copy of it. Both are "pick one of a few", both need the
 * same accessible treatment, and that treatment is easy to get wrong — the
 * selected state has to reach assistive technology through `aria-pressed`,
 * not only through a colour that a screen reader never sees (see #42).
 */

interface SegmentedControlProps<T extends string> {
  /** Names the group for screen readers, e.g. "Stellar Network". */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className = "",
}: SegmentedControlProps<T>) {
  return (
    <div className={`segmented ${className}`.trim()} role="group" aria-label={label}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`segmented__btn ${active ? "segmented__btn--active" : ""}`}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
