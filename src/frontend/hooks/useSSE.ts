import { useEffect, useState } from "preact/hooks";

export function useSSE<T>(eventName: string, token: string) {
  const [events, setEvents] = useState<T[]>([]);

  useEffect(() => {
    if (!token) return;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.addEventListener(eventName, (event) => {
      setEvents((current) => [JSON.parse((event as MessageEvent).data) as T, ...current].slice(0, 100));
    });
    return () => source.close();
  }, [eventName, token]);

  return events;
}
