import { type UiLanguageCode } from "../lib/uiLanguage";

function RuFlatFlag() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className="h-full w-full">
      <rect x="0" y="0" width="40" height="40" fill="#ffffff" />
      <rect x="0" y="13.3" width="40" height="13.4" fill="#2563eb" />
      <rect x="0" y="26.7" width="40" height="13.3" fill="#ef4444" />
      <rect
        x="0.5"
        y="0.5"
        width="39"
        height="39"
        fill="none"
        stroke="#0f172a"
        strokeOpacity="0.1"
        strokeWidth="1"
      />
    </svg>
  );
}

function UsFlatFlag() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" className="h-full w-full">
      <rect x="0" y="0" width="40" height="40" fill="#ffffff" />
      {[...Array(7)].map((_, index) => (
        <rect
          key={`stripe-${index}`}
          x="0"
          y={index * 5.8}
          width="40"
          height="2.9"
          fill="#ef4444"
        />
      ))}
      <rect x="0" y="0" width="18" height="15.5" fill="#1d4ed8" />
      {[...Array(3)].map((_, row) =>
        [...Array(4)].map((__, col) => (
          <circle
            key={`star-${row}-${col}`}
            cx={3 + col * 3.8}
            cy={3.3 + row * 4.6}
            r="0.8"
            fill="#ffffff"
          />
        ))
      )}
      <rect
        x="0.5"
        y="0.5"
        width="39"
        height="39"
        fill="none"
        stroke="#0f172a"
        strokeOpacity="0.1"
        strokeWidth="1"
      />
    </svg>
  );
}

export default function LanguageFlagIcon({
  code,
  className = "h-6 w-6",
}: {
  code: UiLanguageCode;
  className?: string;
}) {
  return (
    <span
      className={`${className} block shrink-0 overflow-hidden rounded-[9px] border border-slate-200 align-middle`}
    >
      {code === "ru" ? <RuFlatFlag /> : <UsFlatFlag />}
    </span>
  );
}
