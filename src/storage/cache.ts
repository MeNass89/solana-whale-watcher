import { LRUCache } from "lru-cache";

export function createLruCache<K extends {}, V extends {}>(max = 10_000): LRUCache<K, V> {
  return new LRUCache<K, V>({ max });
}
