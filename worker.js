import { connect } from 'cloudflare:sockets';
import * as cheerio from 'cheerio';

const TARGET_HOST = 'www.terra-aventura.fr';
const TARGET_PORT = 443;
const CACHE_TTL_SECONDS = 86400; // 24 hours

async function sendRawTLSRequest(method, path, headers = {}, body = '') {
  const socket = connect(`${TARGET_HOST}:${TARGET_PORT}`, { secureTransport: 'on' });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  const reqPath = path.startsWith('/') ? path : `/${path}`;

  const headerLines = [
    `${method.toUpperCase()} ${reqPath} HTTP/1.1`,
    `Host: ${TARGET_HOST}`,
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language: fr-FR,fr;q=0.9,en-US;q=0.8',
    'Connection: close'
  ];

  if (body) {
    headers['Content-Length'] = String(new TextEncoder().encode(body).length);
  }

  for (const [k, v] of Object.entries(headers)) {
    headerLines.push(`${k}: ${v}`);
  }

  const httpRequest = headerLines.join('\r\n') + '\r\n\r\n' + body;

  const encoder = new TextEncoder();
  await writer.write(encoder.encode(httpRequest));

  const decoder = new TextDecoder('utf-8');
  let responseText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      responseText += decoder.decode(value, { stream: true });
    }
  }

  const headerEndIndex = responseText.indexOf('\r\n\r\n');
  if (headerEndIndex === -1) {
    return { status: 0, headers: {}, rawSetCookies: [], body: responseText };
  }

  const rawHeaders = responseText.substring(0, headerEndIndex);
  const rawBody = responseText.substring(headerEndIndex + 4);

  const lines = rawHeaders.split('\r\n');
  const statusLine = lines[0] || '';
  const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

  const resHeaders = {};
  const rawSetCookies = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1) {
      const key = line.substring(0, colonIdx).trim().toLowerCase();
      const val = line.substring(colonIdx + 1).trim();
      resHeaders[key] = val;
      if (key === 'set-cookie') {
        rawSetCookies.push(val);
      }
    }
  }

  return { status, headers: resHeaders, rawSetCookies, body: rawBody };
}

async function loginAndGetCookie(username, password) {
  // 1. Fetch /user/login form to extract hidden build/token IDs
  const loginFormRes = await sendRawTLSRequest('GET', '/user/login');
  const $ = cheerio.load(loginFormRes.body);

  const formBuildId = $('input[name="form_build_id"]').val() || '';
  const formId = $('input[name="form_id"]').val() || 'user_login_form';

  // 2. Build x-www-form-urlencoded POST body
  const formData = new URLSearchParams();
  formData.append('name', username);
  formData.append('pass', password);
  formData.append('form_build_id', formBuildId);
  formData.append('form_id', formId);
  formData.append('op', 'Se connecter');

  const postBody = formData.toString();

  // 3. POST credentials to /user/login
  const loginRes = await sendRawTLSRequest('POST', '/user/login', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': 'has_js=1'
  }, postBody);

  // Extract Drupal session cookie from response set-cookie headers
  let sessionCookie = '';
  for (const sc of loginRes.rawSetCookies) {
    const match = sc.match(/(S?SESS[a-f0-9]+=[\w-]+)/);
    if (match) {
      sessionCookie = match[1];
      break;
    }
  }

  return sessionCookie;
}

function parseDrupalMarkers(html) {
  if (!html) return [];
  try {
    const $ = cheerio.load(html);
    const scriptTag = $('script[type="application/json"][data-drupal-selector="drupal-settings-json"]');
    if (scriptTag.length) {
      const settings = JSON.parse(scriptTag.html());
      return settings.geocaching_map?.markers || settings.drupalSettings?.geocaching_map?.markers || [];
    }
  } catch (e) {
    // Silently handle parse error
  }
  return [];
}

async function getCachedOrFetchMarkers(targetPath, forceRefresh = false, sessionCookie = '') {
  // Hash/fingerprint the session cookie into the cache key to isolate auth cache states
  const cacheKeySuffix = sessionCookie
    ? `-auth-${sessionCookie.substring(0, 15)}`
    : '-public';

  const cacheKey = new Request(`https://${TARGET_HOST}/internal-cache${targetPath}${cacheKeySuffix}`, { method: 'GET' });
  const cache = caches.default;

  if (!forceRefresh) {
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const data = await cachedResponse.json();
      return { markers: data, cached: true };
    }
  }

  const cookieHeader = sessionCookie ? `has_js=1; ${sessionCookie}` : 'has_js=1';
  const rawResponse = await sendRawTLSRequest('GET', targetPath, { 'Cookie': cookieHeader });
  const markers = parseDrupalMarkers(rawResponse.body);

  if (markers && markers.length > 0) {
    const responseToCache = new Response(JSON.stringify(markers), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`
      }
    });
    await cache.put(cacheKey, responseToCache);
  }

  return { markers, cached: false };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    const targetPath = url.searchParams.get('path') || '/parcours';
    const searchQuery = url.searchParams.get('q') || '';
    const forceBypass = url.searchParams.get('force') === 'true' || url.searchParams.get('cache') === 'bypass';

    // Auth inputs: cookie parameter, env variable, OR username/password params
    let sessionCookie = url.searchParams.get('cookie') || env.SESSION_COOKIE || '';
    const username = url.searchParams.get('user') || url.searchParams.get('username') || env.TERRA_USER || '';
    const password = url.searchParams.get('pass') || url.searchParams.get('password') || env.TERRA_PASS || '';

    let credentialSource = 'none';
    if (url.searchParams.get('cookie')) credentialSource = 'url_param_cookie';
    else if (env.SESSION_COOKIE) credentialSource = 'env_session_cookie';
    else if (url.searchParams.get('user') || url.searchParams.get('username')) credentialSource = 'url_param_credentials';
    else if (env.TERRA_USER) credentialSource = 'env_terra_user';

    let loginSuccessful = false;

    try {
      // Perform automated login if credentials are supplied and no cookie is set
      if (!sessionCookie && username && password) {
        sessionCookie = await loginAndGetCookie(username, password);
        loginSuccessful = Boolean(sessionCookie);
      } else if (sessionCookie) {
        loginSuccessful = true;
      }

      const { markers, cached } = await getCachedOrFetchMarkers(targetPath, forceBypass, sessionCookie);

      let resultMarkers = markers;
      if (searchQuery) {
        const normalizeStr = (str) =>
          typeof str === 'string'
            ? str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
            : '';

        const q = normalizeStr(searchQuery);

        resultMarkers = resultMarkers.filter(m => {
          if (normalizeStr(m.title).includes(q)) return true;
          if (normalizeStr(m.nom).includes(q)) return true;
          if (normalizeStr(m.ville).includes(q)) return true;
          if (normalizeStr(m.field_city).includes(q)) return true;
          if (Array.isArray(m.field_departments_cities)) {
            if (m.field_departments_cities.some(item => normalizeStr(item).includes(q))) {
              return true;
            }
          }
          return false;
        });
      }

      // Helper to safely mask sensitive credential info in JSON response
      const maskUsername = (u) => u ? (u.length > 3 ? `${u.substring(0, 2)}***${u.slice(-1)}` : '***') : null;
      const maskCookie = (c) => c ? `${c.substring(0, 12)}...` : null;

      return new Response(JSON.stringify({
        success: true,
        authenticated: Boolean(sessionCookie),
        auth_info: {
          source: credentialSource,
          user_used: maskUsername(username),
          login_successful: loginSuccessful,
          cookie_used: maskCookie(sessionCookie)
        },
        cached,
        count: resultMarkers.length,
        data: resultMarkers
      }, null, 2), {
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600'
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({
        success: false,
        error: err.message
      }, null, 2), {
        status: 500,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
      });
    }
  }
};