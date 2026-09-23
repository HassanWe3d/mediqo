import type { ReactNode } from "react";

export interface PageContainerProps {
  children: ReactNode;
  className?: string;
  /** Narrow reading width (default) vs. wider composition width. */
  width?: "narrow" | "wide";
}

const widthClasses = {
  narrow: "max-w-2xl",
  wide: "max-w-5xl",
};

export function PageContainer({ children, className = "", width = "narrow" }: PageContainerProps) {
  return (
    <div className={`mx-auto w-full px-5 sm:px-8 ${widthClasses[width]} ${className}`}>
      {children}
    </div>
  );
}
