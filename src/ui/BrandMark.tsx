/** A simple chalk stroke, shared with the app icon. */
export function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#2563eb"/>
    <path d="m10 20 1-5 9-9 5 5-9 9-6 1Z" fill="white"/>
    <path d="m18 8 5 5" stroke="#bfdbfe" strokeWidth="2"/>
    <path d="M8 25h15" stroke="white" strokeWidth="2" strokeLinecap="round"/>
  </svg>
}
