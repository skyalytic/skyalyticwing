/** Internal branding uses the existing transparent website asset, never the desktop icon. */
export function BrandLogo({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      width="40"
      height="40"
      viewBox="140 85 340 340"
      role="img"
      aria-label="SkyalyticWing Logo"
      focusable="false"
    >
      {/* Frame the gold emblem at icon sizes; the product name is rendered beside it. */}
      <image href="/logo-transparent.png" width="625" height="625" />
    </svg>
  );
}
