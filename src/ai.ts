const GROQ_API = "https://api.groq.com/openai/v1";

const FALLBACK_CHAIN = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  TAVILY_API_KEY?: string;
  TMDB_API_KEY?: string;
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  REDDIT_USER_AGENT?: string;
  IVY_KV: KVNamespace;
}

interface ChatMessage {
  role: string;
  content?: string | any[];
  tool_call_id?: string;
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type StreamCallback = (text: string, done: boolean) => Promise<void>;

// ===================== Long-Term Memory =====================

export async function loadUserMemories(kv: KVNamespace, chatId: number): Promise<string> {
  const list = await kv.list({ prefix: `memory:${chatId}:`, limit: 50 });
  const items: Array<{ key: string; value: string }> = [];
  for (const k of list.keys) {
    const keyName = k.name.slice(`memory:${chatId}:`.length);
    const val = await kv.get(k.name);
    if (val) items.push({ key: keyName, value: val });
  }
  if (!items.length) return "";
  return items.map((m) => `${m.key}: ${m.value}`).join("\n");
}

export async function clearUserMemories(kv: KVNamespace, chatId: number): Promise<void> {
  const list = await kv.list({ prefix: `memory:${chatId}:` });
  for (const k of list.keys) {
    await kv.delete(k.name);
  }
}

async function memorySave(kv: KVNamespace, chatId: number, key: string, value: string): Promise<string> {
  await kv.put(`memory:${chatId}:${key}`, value);
  return `Saved "${key}" = "${value}"`;
}

async function memoryRecall(kv: KVNamespace, chatId: number, key?: string): Promise<string> {
  if (key) {
    const val = await kv.get(`memory:${chatId}:${key}`);
    return val ?? `No memory found for "${key}".`;
  }
  const list = await kv.list({ prefix: `memory:${chatId}:`, limit: 50 });
  const items: Array<{ key: string; value: string }> = [];
  for (const k of list.keys) {
    const keyName = k.name.slice(`memory:${chatId}:`.length);
    const val = await kv.get(k.name);
    if (val) items.push({ key: keyName, value: val });
  }
  if (!items.length) return "No saved memories.";
  return items.map((m) => `• ${m.key}: ${m.value}`).join("\n");
}

// ===================== URL Fetch =====================

async function fetchUrl(url: string): Promise<string> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return `HTTP ${resp.status}: ${resp.statusText}`;
    const text = await resp.text();
    return text.slice(0, 8000) + (text.length > 8000 ? "\n\n[truncated]" : "");
  } catch (e: any) {
    return `Error fetching URL: ${e.message}`;
  }
}

// ===================== Time =====================

function getCurrentTime(timezone?: string): string {
  const now = new Date();
  if (timezone) {
    try {
      return now.toLocaleString("en-US", { timeZone: timezone });
    } catch {
      return `Invalid timezone. Current UTC: ${now.toISOString()}`;
    }
  }
  return now.toISOString();
}

// ===================== Movie Tools =====================

const TMDB_BASE = "https://api.themoviedb.org/3";

interface MovieResult {
  id: number;
  title: string;
  release_date?: string;
  vote_average?: number;
  overview?: string;
  poster_path?: string;
  genre_ids?: number[];
}

const GENRE_MAP: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie",
  53: "Thriller", 10752: "War", 37: "Western",
};

function formatMovieList(movies: MovieResult[], prefix: string): string {
  if (!movies.length) return "No movies found.";
  return movies
    .map((m, i) => {
      const year = m.release_date ? `(${m.release_date.slice(0, 4)})` : "";
      const rating = m.vote_average ? ` ⭐ ${m.vote_average.toFixed(1)}` : "";
      const genres = m.genre_ids
        ? m.genre_ids.map((g) => GENRE_MAP[g]).filter(Boolean).join(", ")
        : "";
      const genreStr = genres ? ` [${genres}]` : "";
      return `${prefix} ${i + 1}. **${m.title}** ${year}${rating}${genreStr}`;
    })
    .join("\n");
}

async function tmdbFetch(apiKey: string, path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("language", "en-US");
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString());
  if (!resp.ok) return null;
  return resp.json();
}

async function searchMoviesTmdb(apiKey: string, query: string, year?: string): Promise<string> {
  const data = await tmdbFetch(apiKey, "/search/movie", { query, year: year || "", include_adult: "false" });
  if (!data?.results?.length) return "No movies found.";
  return formatMovieList(data.results.slice(0, 8), "🎬");
}

async function getRecommendationsTmdb(apiKey: string, title: string): Promise<string> {
  // Search for the movie first
  const search = await tmdbFetch(apiKey, "/search/movie", { query: title, include_adult: "false" });
  if (!search?.results?.length) return `Could not find "${title}".`;
  const movieId = search.results[0].id;
  const movieName = search.results[0].title;

  const data = await tmdbFetch(apiKey, `/movie/${movieId}/recommendations`);
  if (!data?.results?.length) return `No recommendations found for "${movieName}".`;
  let out = `🎯 *Because you liked ${movieName}:*\n\n`;
  out += formatMovieList(data.results.slice(0, 8), "→");
  return out;
}

async function discoverMoviesTmdb(
  apiKey: string,
  genres?: string,
  minRating?: string,
  year?: string
): Promise<string> {
  const genreMap: Record<string, string> = {};
  for (const [id, name] of Object.entries(GENRE_MAP)) {
    genreMap[name.toLowerCase()] = id;
  }

  let genreIds: string[] = [];
  if (genres) {
    genreIds = genres
      .split(",")
      .map((g) => genreMap[g.trim().toLowerCase()])
      .filter(Boolean) as string[];
  }

  const params: Record<string, string> = {
    sort_by: "vote_average.desc",
    "vote_count.gte": "100",
    include_adult: "false",
  };
  if (genreIds.length) params.with_genres = genreIds.join(",");
  if (minRating) params["vote_average.gte"] = minRating;
  if (year) params.year = year;

  const data = await tmdbFetch(apiKey, "/discover/movie", params);
  if (!data?.results?.length) return "No movies found matching those criteria.";
  let out = "🎬 *Recommended Movies:*\n\n";
  out += formatMovieList(data.results.slice(0, 8), "→");
  return out;
}

// ===================== Reddit API =====================

const REDDIT_AUTH = "https://www.reddit.com/api/v1";
const REDDIT_OAUTH = "https://oauth.reddit.com";

interface RedditToken {
  access_token: string;
  expires_in: number;
  token_type: string;
}

async function getRedditToken(clientId: string, clientSecret: string, userAgent: string): Promise<string | null> {
  const resp = await fetch(`${REDDIT_AUTH}/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) return null;
  const data: RedditToken = await resp.json();
  return data.access_token;
}

async function redditGet(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  path: string,
  params: Record<string, string> = {}
): Promise<any | null> {
  const token = await getRedditToken(clientId, clientSecret, userAgent);
  if (!token) return null;
  const url = new URL(`${REDDIT_OAUTH}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": userAgent,
    },
  });
  if (!resp.ok) return null;
  return resp.json();
}

function formatRedditPosts(data: any, maxPosts = 8): string {
  const children = data?.data?.children;
  if (!children?.length) return "";
  return children
    .slice(0, maxPosts)
    .map((c: any) => {
      const d = c.data;
      const title = d.title || "";
      const sub = d.subreddit ? `r/${d.subreddit}` : "";
      const score = d.ups ? `👍 ${d.ups}` : "";
      const url = d.permalink
        ? `https://old.reddit.com${d.permalink}`
        : d.url || "";
      const self = d.selftext ? (d.selftext.length > 200 ? d.selftext.slice(0, 200) + "…" : d.selftext) : "";
      return `- **${title}** (${sub}, ${score})\n  ${url}${self ? `\n  > ${self.replace(/\n/g, " ")}` : ""}`;
    })
    .join("\n\n");
}

async function redditMovieInfo(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  title: string
): Promise<string | null> {
  // Search r/movies and r/moviecritic for the specific movie
  let out = "";
  for (const sub of ["movies", "moviecritic", "TrueFilm"]) {
    const data = await redditGet(clientId, clientSecret, userAgent, `/r/${sub}/search.json`, {
      q: title,
      restrict_sr: "1",
      sort: "relevance",
      limit: "3",
    });
    if (data) {
      const posts = formatRedditPosts(data, 3);
      if (posts) {
        out += `### r/${sub} discussions:\n${posts}\n\n`;
      }
    }
  }
  return out || null;
}

async function redditMovieRecs(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  preferences: string
): Promise<string | null> {
  let out = "";
  // Primary: r/MovieSuggestions
  const subs = ["MovieSuggestions", "movies", "ifyoulikeblank"];
  for (const sub of subs) {
    const queries = preferences
      ? [
          `"similar to" ${preferences}`,
          `recommendations like ${preferences}`,
          `movies like ${preferences}`,
        ]
      : ["underrated movies", "best movies 2025", "movies you enjoyed"];

    for (const q of queries) {
      const data = await redditGet(clientId, clientSecret, userAgent, `/r/${sub}/search.json`, {
        q,
        restrict_sr: "1",
        sort: "top",
        limit: "3",
      });
      if (data) {
        const posts = formatRedditPosts(data, 3);
        if (posts) {
          out += `### r/${sub} — "${q}":\n${posts}\n\n`;
          break; // One good query per subreddit is enough
        }
      }
    }
  }

  // Also get hot/rising from MovieSuggestions for general recs
  if (!out) {
    const hot = await redditGet(clientId, clientSecret, userAgent, "/r/MovieSuggestions/hot.json", { limit: "5" });
    if (hot) {
      const posts = formatRedditPosts(hot, 5);
      if (posts) out += `### r/MovieSuggestions (hot):\n${posts}\n\n`;
    }
  }

  return out || null;
}

async function redditDiscoverMovies(
  clientId: string,
  clientSecret: string,
  userAgent: string,
  genres?: string,
  year?: string
): Promise<string | null> {
  let out = "";
  const subs = ["movies", "MovieSuggestions"];
  const qParts: string[] = [];
  if (genres) qParts.push(`"${genres}"`);
  if (year) qParts.push(year);
  qParts.push("recommendations");
  const query = qParts.join(" ");

  for (const sub of subs) {
    const data = await redditGet(clientId, clientSecret, userAgent, `/r/${sub}/search.json`, {
      q: query,
      restrict_sr: "1",
      sort: "top",
      limit: "5",
      t: "year",
    });
    if (data) {
      const posts = formatRedditPosts(data, 5);
      if (posts) {
        out += `### r/${sub}:\n${posts}\n\n`;
      }
    }
  }

  return out || null;
}

// ===================== Tavily with Reddit targeting =====================

async function tavilySearch(apiKey: string, query: string): Promise<string | null> {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "advanced",
      max_results: 5,
      include_answer: true,
    }),
  });
  if (!resp.ok) return null;
  const data: any = await resp.json();
  if (!data.results?.length) return null;
  let out = data.answer ? `**Summary:** ${data.answer}\n\n` : "";
  out += data.results
    .map((r: any, i: number) => `${i + 1}. [${r.title}](${r.url}) — ${(r.content || "").slice(0, 300)}`)
    .join("\n\n");
  return out;
}

async function movieInfoTavily(apiKey: string, title: string): Promise<string> {
  const redditQuery = `site:reddit.com ${title} movie review discussion r/movies r/moviecritic`;
  const redditResult = await tavilySearch(apiKey, redditQuery);
  if (redditResult) return `🗣️ *What Reddit says about "${title}":*\n\n${redditResult}`;

  // Fallback: general search
  const generalResult = await tavilySearch(apiKey, `${title} movie rating cast review 2024 2025`);
  if (generalResult) return generalResult;
  return "No information found.";
}

async function movieRecsTavily(apiKey: string, preferences: string): Promise<string> {
  // First try: Reddit-specific
  const redditQuery = preferences
    ? `site:reddit.com r/MovieSuggestions OR r/ifyoulikeblank OR r/movies movies like similar to ${preferences} recommendations`
    : "site:reddit.com r/MovieSuggestions best underrated movies reddit recommends";
  const redditResult = await tavilySearch(apiKey, redditQuery);
  if (redditResult) return `🗣️ *Reddit recommendations:*\n\n${redditResult}`;

  // Fallback: general
  const generalQuery = preferences
    ? `best movies similar to ${preferences} trending 2024 2025 2026`
    : "best movies to watch right now trending popular critics choice";
  const generalResult = await tavilySearch(apiKey, generalQuery);
  if (generalResult) return generalResult;
  return "No recommendations found.";
}

async function discoverTavily(apiKey: string, genres?: string, year?: string, minRating?: string): Promise<string> {
  const qParts: string[] = ["site:reddit.com r/movies OR r/MovieSuggestions"];
  if (genres) qParts.push(genres);
  if (year) qParts.push(year);
  if (minRating) qParts.push(`rated ${minRating}/10`);
  qParts.push("recommendations best");
  const redditResult = await tavilySearch(apiKey, qParts.join(" "));
  if (redditResult) return `🗣️ *What Reddit recommends:*\n\n${redditResult}`;

  // General fallback
  const gParts: string[] = [];
  if (genres) gParts.push(genres);
  if (year) gParts.push(year);
  gParts.push("movies best rated");
  if (minRating) gParts.push(minRating);
  const generalResult = await tavilySearch(apiKey, gParts.join(" "));
  if (generalResult) return generalResult;
  return "No movies found matching those criteria.";
}

// ===================== Reminder Tools =====================

async function createReminder(kv: KVNamespace, chatId: number, timeStr: string, message: string) {
  let timestamp: number;
  if (/^\d{1,2}:\d{2}$/.test(timeStr)) {
    const [h, m] = timeStr.split(":").map(Number);
    const t = new Date();
    t.setUTCHours(h, m, 0, 0);
    if (t <= new Date()) t.setUTCDate(t.getUTCDate() + 1);
    timestamp = t.getTime();
  } else {
    timestamp = new Date(timeStr).getTime();
    if (isNaN(timestamp)) return null;
  }
  const id = crypto.randomUUID().slice(0, 8);
  await kv.put(`reminder:${timestamp}:${id}`, JSON.stringify({ chat_id: chatId, message }));
  return { id, timestamp };
}

async function listReminders(kv: KVNamespace, chatId: number) {
  const list = await kv.list({ prefix: "reminder:" });
  const items: Array<{ id: string; timestamp: number; message: string }> = [];
  for (const key of list.keys) {
    const val: any = await kv.get(key.name, "json");
    if (val?.chat_id === chatId) {
      const parts = key.name.split(":");
      items.push({ id: parts[2], timestamp: parseInt(parts[1]), message: val.message });
    }
  }
  return items.sort((a, b) => a.timestamp - b.timestamp);
}

async function cancelReminder(kv: KVNamespace, chatId: number, reminderId: string) {
  const list = await kv.list({ prefix: "reminder:" });
  for (const key of list.keys) {
    if (key.name.endsWith(`:${reminderId}`)) {
      const val: any = await kv.get(key.name, "json");
      if (val?.chat_id === chatId) {
        await kv.delete(key.name);
        return true;
      }
    }
  }
  return false;
}

async function searchWeb(apiKey: string, query: string) {
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "advanced",
      max_results: 5,
      include_answer: true,
    }),
  });
  if (!resp.ok) return `Search failed (${resp.status})`;
  const data: any = await resp.json();
  if (!data.results?.length) return "No results found.";
  let out = data.answer ? `**Summary:** ${data.answer}\n\n` : "";
  out += data.results
    .map((r: any, i: number) => `${i + 1}. [${r.title}](${r.url}) — ${(r.content || "").slice(0, 300)}`)
    .join("\n\n");
  return out;
}

// ===================== Tool Definitions =====================

function getTools(env: Env) {
  const tools: Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: Record<string, any>;
    };
  }> = [
    {
      type: "function",
      function: {
        name: "create_reminder",
        description: "Schedule a reminder at a specific time. Call this when the user asks to be reminded or notified.",
        parameters: {
          type: "object",
          properties: {
            time: { type: "string", description: "Time in HH:MM (24-hour) format" },
            message: { type: "string", description: "The reminder message" },
          },
          required: ["time", "message"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_reminders",
        description: "List all active reminders.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "cancel_reminder",
        description: "Cancel a reminder by its ID.",
        parameters: {
          type: "object",
          properties: {
            reminder_id: { type: "string", description: "The ID of the reminder to cancel" },
          },
          required: ["reminder_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_save",
        description: "Save a fact or preference about the user to long-term memory so you can recall it across conversations. Call this whenever you learn something personal about the user.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Short descriptive key like 'name', 'favorite_color', 'job_title'" },
            value: { type: "string", description: "The value to remember" },
          },
          required: ["key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_recall",
        description: "Recall saved facts or preferences about the user from long-term memory.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Optional specific key to recall. Omit to list everything." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch the content of a URL. Use this to read web pages, articles, docs, or API responses.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_current_time",
        description: "Get the current time, optionally in a specific timezone (e.g., 'America/New_York', 'Asia/Kolkata', 'UTC').",
        parameters: {
          type: "object",
          properties: {
            timezone: { type: "string", description: "Optional IANA timezone name" },
          },
        },
      },
    },
  ];
  if (env.TAVILY_API_KEY) {
    tools.push({
      type: "function",
      function: {
        name: "search_web",
        description: "Search the web for current information on a topic. Use this for research and fact-checking.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
          },
          required: ["query"],
        },
      },
    });
  }

  // Movie tools — TMDB → Reddit → Tavily with Reddit targeting
  const hasMovieTools = !!(env.TMDB_API_KEY || (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) || env.TAVILY_API_KEY);
  if (hasMovieTools) {
    tools.push({
      type: "function",
      function: {
        name: "get_movie_info",
        description: "Get detailed information about a movie including rating, cast overview, release year. Use this when the user asks about a specific movie.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "The movie title" },
            year: { type: "string", description: "Optional release year" },
          },
          required: ["title"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "get_movie_recommendations",
        description: "Get movie recommendations similar to a given movie title. Use this when the user wants suggestions based on a movie they liked.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "A movie title the user enjoyed" },
          },
          required: ["title"],
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "discover_movies",
        description: "Discover movies by genre, minimum rating, or year. Use this when the user wants to find movies to watch based on preferences like 'action movies from 2024'.",
        parameters: {
          type: "object",
          properties: {
            genres: { type: "string", description: "Comma-separated genres like 'Action, Sci-Fi, Comedy'" },
            min_rating: { type: "string", description: "Minimum rating (0-10) like '7'" },
            year: { type: "string", description: "Release year like '2024'" },
          },
        },
      },
    });
  }

  return tools;
}

// ===================== Function Call Dispatcher =====================

async function handleFunctionCall(env: Env, chatId: number, toolCall: GroqToolCall): Promise<string> {
  const args = JSON.parse(toolCall.function.arguments);
  switch (toolCall.function.name) {
    case "create_reminder": {
      const result = await createReminder(env.IVY_KV, chatId, args.time, args.message);
      if (!result) return "Could not parse that time. Please use HH:MM format.";
      return JSON.stringify({
        status: "created",
        id: result.id,
        timestamp: result.timestamp,
        display: `<t:${Math.floor(result.timestamp / 1000)}:f>`,
        message: args.message,
      });
    }
    case "list_reminders": {
      const items = await listReminders(env.IVY_KV, chatId);
      return JSON.stringify(
        items.map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          message: r.message,
          display: `<t:${Math.floor(r.timestamp / 1000)}:R>`,
        }))
      );
    }
    case "cancel_reminder": {
      const ok = await cancelReminder(env.IVY_KV, chatId, args.reminder_id);
      return JSON.stringify({ status: ok ? "cancelled" : "not_found" });
    }
    case "search_web":
      return await searchWeb(env.TAVILY_API_KEY!, args.query);
    case "memory_save":
      return await memorySave(env.IVY_KV, chatId, args.key, args.value);
    case "memory_recall":
      return await memoryRecall(env.IVY_KV, chatId, args.key);
    case "fetch_url":
      return await fetchUrl(args.url);
    case "get_current_time":
      return getCurrentTime(args.timezone);
    case "get_movie_info": {
      // TMDB → Reddit → Tavily (Reddit-targeted)
      if (env.TMDB_API_KEY) {
        const tmdbResult = await searchMoviesTmdb(env.TMDB_API_KEY, args.title, args.year);
        // Add Reddit flavor if available
        if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
          const redditInfo = await redditMovieInfo(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
          if (redditInfo) {
            return `${tmdbResult}\n\n---\n\n🗣️ *Reddit discussions:*\n${redditInfo}`;
          }
        }
        return tmdbResult;
      }
      if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
        const redditInfo = await redditMovieInfo(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
        if (redditInfo) return `🗣️ *Reddit discussions about "${args.title}":*\n\n${redditInfo}`;
      }
      if (env.TAVILY_API_KEY) return await movieInfoTavily(env.TAVILY_API_KEY, args.title);
      return "Movie search is not configured.";
    }
    case "get_movie_recommendations": {
      // TMDB → Reddit → Tavily (Reddit-targeted)
      if (env.TMDB_API_KEY) {
        const tmdbResult = await getRecommendationsTmdb(env.TMDB_API_KEY, args.title);
        // Add Reddit recs as bonus
        let combined = tmdbResult;
        if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
          const redditRecs = await redditMovieRecs(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
          if (redditRecs) {
            combined += `\n\n---\n\n🗣️ *What Reddit recommends:*\n${redditRecs}`;
          }
        }
        return combined;
      }
      if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
        const redditRecs = await redditMovieRecs(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT, args.title);
        if (redditRecs) return `🗣️ *Reddit recommendations for "${args.title}":*\n\n${redditRecs}`;
      }
      if (env.TAVILY_API_KEY) return await movieRecsTavily(env.TAVILY_API_KEY, args.title);
      return "Movie recommendations are not configured.";
    }
    case "discover_movies": {
      // TMDB → Reddit → Tavily (Reddit-targeted)
      if (env.TMDB_API_KEY) {
        const tmdbResult = await discoverMoviesTmdb(env.TMDB_API_KEY, args.genres, args.min_rating, args.year);
        let combined = tmdbResult;
        if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
          const redditDiscover = await redditDiscoverMovies(
            env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT,
            args.genres, args.year
          );
          if (redditDiscover) {
            combined += `\n\n---\n\n🗣️ *Reddit discussions:*\n${redditDiscover}`;
          }
        }
        return combined;
      }
      if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USER_AGENT) {
        const redditDiscover = await redditDiscoverMovies(
          env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, env.REDDIT_USER_AGENT,
          args.genres, args.year
        );
        if (redditDiscover) return `🗣️ *Reddit recommends:*\n\n${redditDiscover}`;
      }
      if (env.TAVILY_API_KEY) return await discoverTavily(env.TAVILY_API_KEY, args.genres, args.year, args.min_rating);
      return "Movie discovery is not configured.";
    }
    default:
      return `Unknown tool: ${toolCall.function.name}`;
  }
}

// ===================== Groq API Call =====================

const MODEL_MAX_TOKENS: Record<string, number> = {
  "meta-llama/llama-4-scout-17b-16e-instruct": 8192,
  "llama-3.3-70b-versatile": 32768,
  "llama-3.1-8b-instant": 131072,
};

async function callGroq(
  apiKey: string,
  messages: ChatMessage[],
  tools: any[],
  model: string
): Promise<
  | { choices: Array<{ message: { content?: string; tool_calls?: GroqToolCall[] } }> }
  | { _rateLimited: true; model: string }
  | { _retry: true }
> {
  const maxTokens = MODEL_MAX_TOKENS[model] ?? 8192;
  const body: Record<string, any> = { model, messages, max_tokens: maxTokens, temperature: 0.7 };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const resp = await fetch(`${GROQ_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (resp.status === 429) return { _rateLimited: true, model };
  if (!resp.ok) {
    const err = await resp.text();
    if (tools.length && resp.status === 400 && err.includes("tool_use_failed")) return { _retry: true };
    throw new Error(`Groq API error ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
}

// ===================== Simulated Streaming =====================

async function revealText(onStream: StreamCallback | undefined, text: string) {
  if (!onStream || !text) return;
  const step = 25;
  let pos = Math.min(60, text.length);
  while (pos < text.length) {
    await onStream(text.slice(0, pos), false);
    pos = Math.min(pos + step, text.length);
  }
  await onStream(text, true);
}

// ===================== Main AI Processor with GOAP + Tool Loop =====================

async function processAiInternal(
  env: Env,
  messages: ChatMessage[],
  chatId: number,
  preferredModel: string | undefined,
  onStream?: StreamCallback,
  maxDepth = 5
): Promise<{ text: string; modelUsed: string }> {
  const tools = getTools(env);

  const chain = preferredModel && FALLBACK_CHAIN.includes(preferredModel)
    ? [preferredModel, ...FALLBACK_CHAIN.filter((m) => m !== preferredModel)]
    : FALLBACK_CHAIN;

  for (let attempt = 0; attempt < chain.length; attempt++) {
    const model = chain[attempt];
    const currentMessages: ChatMessage[] = JSON.parse(JSON.stringify(messages));
    let useTools = tools.length > 0;

    for (let turn = 0; turn < maxDepth; turn++) {
      const response = await callGroq(env.GROQ_API_KEY, currentMessages, useTools ? tools : [], model);

      if ("_rateLimited" in response) break;
      if ("_retry" in response) {
        useTools = false;
        continue;
      }

      const msg = (response as any).choices[0].message;

      if (!msg.tool_calls) {
        const text = msg.content || "No response.";
        await revealText(onStream, text);
        return { text, modelUsed: model };
      }

      currentMessages.push({ role: "assistant", content: msg.content || "" });
      for (const tc of msg.tool_calls) {
        const result = await handleFunctionCall(env, chatId, tc);
        currentMessages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }
    }
  }

  return { text: "I'm rate-limited across all models right now. Please try again in a minute 💜", modelUsed: "none" };
}

// ===================== Public API =====================

export async function processAi(
  env: Env,
  history: ChatMessage[],
  chatId: number,
  preferredModel?: string
): Promise<{ text: string; modelUsed: string }> {
  return processAiInternal(env, [...history], chatId, preferredModel);
}

export async function processAiStream(
  env: Env,
  history: ChatMessage[],
  chatId: number,
  onStream: StreamCallback,
  preferredModel?: string
): Promise<{ text: string; modelUsed: string }> {
  return processAiInternal(env, [...history], chatId, preferredModel, onStream);
}

// ===================== Voice Transcription =====================

export async function transcribeAudio(env: Env, fileUrl: string): Promise<string> {
  const audioResp = await fetch(fileUrl);
  const blob = await audioResp.blob();
  const formData = new FormData();
  formData.append("file", blob, "audio.ogg");
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("response_format", "json");
  const resp = await fetch(`${GROQ_API}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: formData,
  });
  if (!resp.ok) throw new Error(`Transcription failed: ${resp.status}`);
  const data: any = await resp.json();
  return data.text || "";
}

// ===================== Document Text Extraction =====================

const TEXT_EXTENSIONS = new Set([
  "txt", "csv", "json", "xml", "md", "html", "htm", "log",
  "cfg", "ini", "yaml", "yml", "toml", "env",
  "py", "js", "ts", "rs", "go", "java", "c", "cpp", "h", "hpp",
  "sh", "bash", "zsh", "fish", "ps1", "bat",
  "sql", "r", "rb", "php", "swift", "kt", "scala",
  "tex", "rst", "asciidoc", "adoc",
]);

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/javascript",
  "application/typescript",
];

export function isTextDocument(filename: string, mimeType?: string): boolean {
  if (mimeType && TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return true;
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}

export function isPdfDocument(mimeType?: string, filename?: string): boolean {
  if (mimeType === "application/pdf") return true;
  return filename?.toLowerCase().endsWith(".pdf") ?? false;
}

export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  const raw = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buffer);
  const parts: string[] = [];

  // PDF metadata (always uncompressed)
  const infoMatch = raw.match(/<<\s*\/Info\s+(\d+\s+\d+\s+R)/);
  if (infoMatch) {
    const infoRef = infoMatch[1].trim();
    // Try to find the info dict content
    const infoDict = raw.match(new RegExp(`${infoRef.replace(/\s+/g, '\\s+')}\\s*obj[^>]*>>`));
    if (infoDict) {
      const meta = infoDict[0].match(/\/Title\s*\(([^)]*)\)|\/Author\s*\(([^)]*)\)|\/Subject\s*\(([^)]*)\)/g);
      if (meta) {
        parts.push("[Document Info]");
        for (const m of meta) {
          const val = m.replace(/\/\w+\s*\(/, "").replace(/\)$/, "");
          parts.push(m.split(/\s/)[0].slice(1) + ": " + val);
        }
      }
    }
  }

  // Extract text from uncompressed content streams: (text) Tj / TJ / '
  const textOps = [
    ...raw.matchAll(/\(([^)]*)\)\s*Tj/g),
    ...raw.matchAll(/\(([^)]*)\)\s*'/g),
    ...raw.matchAll(/\(([^)]*)\)\s*"/g),
  ];
  for (const m of textOps) {
    parts.push(m[1]);
  }

  // TJ arrays: [(text) num (text)] TJ
  const tjArrays = raw.matchAll(/\[([^\]]*)\]\s*TJ/g);
  for (const arr of tjArrays) {
    const contents = arr[1].match(/\(([^)]*)\)/g);
    if (contents) {
      for (const c of contents) {
        parts.push(c.slice(1, -1));
      }
    }
  }

  if (!parts.length) {
    return "This PDF appears to be a scanned document or image-based PDF. I cannot extract text from it.";
  }

  // Decode PDF escape sequences
  const decoded = parts
    .map((t) =>
      t
        .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
        .replace(/\\(n)/g, "\n")
        .replace(/\\(r)/g, "\r")
        .replace(/\\(t)/g, "\t")
        .replace(/\\(.)/g, "$1")
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return decoded.slice(0, 10000) + (decoded.length > 10000 ? "\n\n[truncated at 10,000 characters]" : "");
}

// ===================== Image to base64 =====================

export async function fileToBase64(fileUrl: string): Promise<string> {
  const resp = await fetch(fileUrl);
  const blob = await resp.blob();
  const buffer = await blob.arrayBuffer();
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

// ===================== LaTeX Renderer =====================

export async function renderLatex(env: Env, chatId: number, formula: string): Promise<string> {
  const body = new URLSearchParams({
    formula: `\\[${formula}\\]`,
    format: "png",
    fsize: "20",
    fcolor: "FFFFFF",
    mode: "0",
    out: "1",
    remhost: "quicklatex.com",
  });
  const resp = await fetch("https://quicklatex.com/latex3.f", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!resp.ok) return "LaTeX render failed.";
  const raw = await resp.text();
  const lines = raw.trim().split("\n");
  if (lines[0] !== "0" || !lines[1]) return "LaTeX render error.";
  const url = lines[1].trim().split(/\s+/)[0];
  try {
    const imgResp = await fetch(url);
    if (imgResp.ok) {
      const blob = await imgResp.blob();
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("photo", blob, "latex.png");
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
    }
  } catch {}
  return "Rendered LaTeX formula as image above.";
}

// ===================== Mermaid Renderer =====================

async function deflateBase64Url(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return btoa(String.fromCharCode(...out)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function renderMermaid(env: Env, chatId: number, diagram: string): Promise<string> {
  const encoded = await deflateBase64Url(diagram);
  const renderUrl = `https://kroki.io/mermaid/png/${encoded}`;
  const resp = await fetch(renderUrl);
  if (!resp.ok) return "Mermaid render failed.";
  try {
    const blob = await resp.blob();
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, "mermaid.png");
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
  } catch {}
  return "Rendered Mermaid diagram as image above.";
}
