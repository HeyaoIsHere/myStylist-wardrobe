interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  sub?: string;
  right?: React.ReactNode;
  className?: string;
}

/** Editorial section header: small-caps eyebrow, serif title, quiet subtitle. */
export function SectionHeading({ eyebrow, title, sub, right, className = "" }: SectionHeadingProps) {
  return (
    <div className={`mb-8 flex flex-wrap items-end justify-between gap-4 ${className}`}>
      <div>
        {eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}
        <h2 className="serif-display text-3xl leading-tight md:text-4xl">{title}</h2>
        {sub && <p className="mt-2 max-w-xl text-sm text-ink-soft">{sub}</p>}
      </div>
      {right}
    </div>
  );
}
