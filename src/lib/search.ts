export type StreamPlatform = "youtube" | "twitch" | "niconico";

export interface SearchCard {
  isJapanese: boolean;
  platform: StreamPlatform;
  searchText: string;
}

export interface SearchFilters {
  japaneseOnly: boolean;
  platform?: StreamPlatform;
  query: string;
}

export function isCardVisible(card: SearchCard, filters: SearchFilters): boolean {
  if (filters.japaneseOnly && !card.isJapanese) return false;
  if (filters.platform !== undefined && card.platform !== filters.platform) return false;
  return card.searchText.includes(filters.query.toLowerCase());
}

export function hasVisibleCard(cards: SearchCard[], filters: SearchFilters): boolean {
  return cards.some((card) => isCardVisible(card, filters));
}
