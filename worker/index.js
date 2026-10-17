const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// Csak ezek a hostok proxyzhatók — megakadályozza, hogy idegenek abuse-olják a Workert
const ALLOWED_HOSTS = new Set([
  // Anthropic API:
  'api.anthropic.com',
  // Piaci adatforrások (már használja az app):
  'query1.finance.yahoo.com',
  'api.frankfurter.app',
  'wise.com',
  'www.cnbc.com',
  // RSS feed-ek az AI napi kommentárhoz:
  'www.mnb.hu',
  'www.portfolio.hu',
  'feeds.reuters.com',
  'www.reutersagency.com',
  'feeds.marketwatch.com',
]);

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    const apikey = url.searchParams.get('apikey');
    if (!target) return new Response('Missing url param', { status: 400, headers: CORS });

    // Host allowlist ellenőrzés
    let targetHost;
    try {
      targetHost = new URL(target).hostname;
    } catch {
      return new Response('Invalid url param', { status: 400, headers: CORS });
    }
    if (!ALLOWED_HOSTS.has(targetHost)) {
      return new Response('Host not allowed', { status: 403, headers: { ...CORS, 'x-deny-reason': 'host_not_allowed' } });
    }

    const isAnthropic = targetHost === 'api.anthropic.com';

    const headers = {
      'User-Agent': 'Mozilla/5.0',
      // Accept: az RSS feedek XML-t adnak, a többi (Yahoo, Frankfurter, Anthropic) JSON-t, a CNBC HTML-t
      'Accept': isAnthropic ? 'application/json' : 'application/json, application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.7',
    };

    // Anthropic-specifikus header-ek csak az Anthropic-ra:
    if (isAnthropic) {
      headers['anthropic-version'] = '2023-06-01';
      if (apikey) headers['x-api-key'] = apikey;
      else if (request.headers.get('x-api-key')) headers['x-api-key'] = request.headers.get('x-api-key');
    }

    if (request.headers.get('content-type')) headers['content-type'] = request.headers.get('content-type');

    const init = { headers };
    if (request.method === 'POST') {
      init.method = 'POST';
      init.body = await request.text();
    }

    const resp = await fetch(target, init);
    const body = await resp.text();

    return new Response(body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') || 'application/json',
        ...CORS
      }
    });
  }
}