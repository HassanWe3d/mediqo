export interface SectionHeadingProps {
  eyebrow?: string;
  title: string;
  description?: string;
  align?: "left" | "center";
  className?: string;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "left",
  className = "",
}: SectionHeadingProps) {
  const alignment = align === "center" ? "items-center text-center" : "items-start";
  return (
    <div className={`flex flex-col gap-2 ${alignment} ${className}`}>
      {eyebrow && (
        <p className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-accent">
          {eyebrow}
        </p>
      )}
      <h2 className="text-2xl font-semibold text-ink sm:text-[28px]">{title}</h2>
      {description && (
        <p className="max-w-prose text-[15px] leading-relaxed text-muted">{description}</p>
      )}
    </div>
  );
}
