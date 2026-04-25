import { cookies } from "next/headers";

import HomePageClient from "../components/HomePageClient";
import { isSearchMode, SEARCH_MODE_STORAGE_KEY } from "../lib/searchMode";

export default async function HomePage() {
  const cookieStore = await cookies();
  const savedSearchMode = cookieStore.get(SEARCH_MODE_STORAGE_KEY)?.value;
  const initialSearchMode = isSearchMode(savedSearchMode)
    ? savedSearchMode
    : "Browser";

  return <HomePageClient initialSearchMode={initialSearchMode} />;
}
