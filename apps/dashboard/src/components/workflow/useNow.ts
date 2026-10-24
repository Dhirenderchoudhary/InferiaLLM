import { useEffect, useState } from "react";

// Ticks only while active so an idle canvas never re-renders on a timer.
export function useNow(active: boolean, intervalMs = 50): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(performance.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
