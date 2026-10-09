export function Wordmark({ height = 44 }: { height?: number }) {
  // Both lockups are in the DOM; CSS shows the one that matches the active theme.
  return (
    <span class="wordmark" style={{ height: `${height}px` }}>
      <img class="wm-light" src="/wordmark-light.png" alt="Foxfleet" height={height} />
      <img class="wm-dark" src="/wordmark-dark.png" alt="" aria-hidden="true" height={height} />
    </span>
  );
}
