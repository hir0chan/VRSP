export type Locale = "ja" | "en";

interface Translation {
  title: string;
  description: string;
  siteName: string;
  brandAriaLabel: string;
  updatedPrefix: string;
  heroEyebrow: string;
  heroTitleBeforeEmphasis: string;
  heroTitleEmphasis: string;
  heroCopy: string;
  liveSection: string;
  todaySection: string;
  upcomingSection: string;
  todayEmpty: string;
  upcomingEmpty: string;
  platformLegend: string;
  platformAll: string;
  platformNiconico: string;
  japaneseOnly: string;
  searchPlaceholder: string;
  searchNoResults: string;
  totalCount: (count: number) => string;
  openStream: (title: string) => string;
  watchStream: string;
  niconicoLiveAlt: string;
  dateTbd: string;
  sponsorSection: string;
  sponsorPrLabel: string;
  sponsorRecruitTitle: string;
  sponsorRecruitCopy: string;
  sponsorRecruitCta: string;
  supportLinkLabel: string;
  footerBeforeHandle: string;
  footerAfterHandle: string;
  footerAuthor: string;
}

const translations: Record<Locale, Translation> = {
  ja: {
    title: "ぶいちゃ配信アンテナ | VRChatのライブ配信・配信予定まとめ",
    description:
      "VRChat系配信者のライブ配信と今後の配信予定をひとつにまとめたスケジュールポータルです。",
    siteName: "ぶいちゃ配信アンテナ",
    brandAriaLabel: "ぶいちゃ配信アンテナ ホーム",
    updatedPrefix: "最終更新: ",
    heroEyebrow: "VRCHAT STREAM ANTENNA",
    heroTitleBeforeEmphasis: "今日、バーチャルの",
    heroTitleEmphasis: "どこへ行く？",
    heroCopy:
      "VRChatを旅する配信者たちのライブと、これから始まる配信をひとつの場所で。",
    liveSection: "NOW ON LIVE",
    todaySection: "本日の配信",
    upcomingSection: "今後の配信",
    todayEmpty: "本日の配信予定はありません。",
    upcomingEmpty: "今後の配信予定はありません。",
    platformLegend: "プラットフォーム",
    platformAll: "すべて",
    platformNiconico: "ニコ生",
    japaneseOnly: "日本語のみ",
    searchPlaceholder: "配信者・タイトルで絞り込み",
    searchNoResults: "条件に一致する配信はありません。",
    totalCount: (count) => `全${count}件`,
    openStream: (title) => `${title}の配信ページを見る`,
    watchStream: "配信ページへ",
    niconicoLiveAlt: "ニコニコ生放送",
    dateTbd: "日付未定",
    sponsorSection: "コミュニティ枠",
    sponsorPrLabel: "PR",
    sponsorRecruitTitle: "この枠に掲載しませんか？",
    sponsorRecruitCopy:
      "コミュニティ活動やサービスの掲載を募集しています。お気軽にご相談ください。",
    sponsorRecruitCta: "X の DM で相談",
    supportLinkLabel: "このサイトを応援する",
    footerBeforeHandle:
      "本サイトはすべての VRChat 配信者・コンテンツを網羅しているわけではありません。また、取得の仕組み上、VRChat 以外のコンテンツが掲載されることがあります。掲載の削除をご希望の場合は X ",
    footerAfterHandle:
      " までご連絡ください。本サイトはアクセス状況の把握のため Google Analytics を使用しています。",
    footerAuthor: "ぶいちゃ配信アンテナ by hir0chan",
  },
  en: {
    title: "VRChat Stream Antenna | VRChat Live Streams & Schedule",
    description:
      "Live streams and upcoming broadcasts from VRChat streamers — all in one place.",
    siteName: "VRChat Stream Antenna",
    brandAriaLabel: "VRChat Stream Antenna home",
    updatedPrefix: "Last updated: ",
    heroEyebrow: "VRCHAT STREAM ANTENNA",
    heroTitleBeforeEmphasis: "Where in the virtual world",
    heroTitleEmphasis: "will you go today?",
    heroCopy:
      "Live streams from VRChat streamers and what's coming next — all in one place.",
    liveSection: "NOW ON LIVE",
    todaySection: "Today's Streams",
    upcomingSection: "Upcoming Streams",
    todayEmpty: "No streams scheduled for today.",
    upcomingEmpty: "No upcoming streams scheduled.",
    platformLegend: "Platform",
    platformAll: "All",
    platformNiconico: "Niconico",
    japaneseOnly: "Japanese only",
    searchPlaceholder: "Filter by streamer or title",
    searchNoResults: "No streams match your filters.",
    totalCount: (count) => `${count} total`,
    openStream: (title) => `Open the stream page for ${title}`,
    watchStream: "Watch stream",
    niconicoLiveAlt: "Niconico Live",
    dateTbd: "Date TBD",
    sponsorSection: "Community",
    sponsorPrLabel: "PR",
    sponsorRecruitTitle: "Want to be featured here?",
    sponsorRecruitCopy:
      "We welcome community activities and services. Get in touch to learn more.",
    sponsorRecruitCta: "DM us on X",
    supportLinkLabel: "Support this site",
    footerBeforeHandle:
      "This site does not cover every VRChat streamer or every piece of content, and non-VRChat content may occasionally appear due to how data is collected. To request removal of a listing, please contact ",
    footerAfterHandle:
      " on X. This site uses Google Analytics to understand site traffic.",
    footerAuthor: "VRChat Stream Antenna by hir0chan",
  },
};

export function getTranslation(locale: Locale): Translation {
  return translations[locale];
}
