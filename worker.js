import * as cheerio from 'cheerio';

const TARGET_URL = 'https://www.terra-aventura.fr/parcours';
const CACHE_TTL = 86400; // 24 hours in seconds

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const searchQuery = url.searchParams.get('q') || '';
    const forceRefresh = url.searchParams.get('refresh') === 'true' || url.searchParams.get('force') === 'true';

    // Construct a cache key based on the target URL
    const cacheKey = new URL(TARGET_URL);
    const cache = caches.default;

    let html = null;

    // 1. Check cache unless a manual refresh was requested
    if (!forceRefresh) {
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        html = await cachedResponse.text();
      }
    }

    // 2. Fetch from source if not cached or if refresh is forced
    if (!html) {
      const response = await fetch(TARGET_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        return new Response(JSON.stringify({ success: false, error: "Failed to fetch source website" }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      html = await response.text();

      // Store in Cloudflare's edge cache for 24 hours
      const responseToCache = new Response(html, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Cache-Control': `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`
        }
      });
      ctx.waitUntil(cache.put(cacheKey, responseToCache));
    }

    try {
      // 3. Parse HTML and extract Drupal Settings
      const $ = cheerio.load(html);
      const scriptTag = $('script[type="application/json"][data-drupal-selector="drupal-settings-json"]');
      
      if (!scriptTag.length) {
        throw new Error("Impossible de trouver la balise drupal-settings-json.");
      }

      const settings = JSON.parse(scriptTag.html());
      const markers = settings.geocaching_map?.markers || [];

      // 4. Filter results based on search query
      let results = markers;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        results = markers.filter(marker => {
          const title = (marker.title || '').toLowerCase();
          const city = (marker.field_city || marker.city || marker.commune || '').toLowerCase();
          return title.includes(query) || city.includes(query);
        });
      }

      return new Response(JSON.stringify({
        success: true,
        cached: !forceRefresh,
        query: searchQuery,
        count: results.length,
        results: results
      }, null, 2), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
      });

    } catch (error) {
      return new Response(JSON.stringify({ success: false, error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
