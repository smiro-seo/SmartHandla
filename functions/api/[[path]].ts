// Cloudflare Pages Function — proxies Gemini REST API calls.
//
// The browser sends requests to /api/… without an API key.
// This function injects GEMINI_API_KEY (a server-side env variable) and
// forwards the request to generativelanguage.googleapis.com, so the key
// is never exposed in the browser or in client-visible URLs.
//
// Set GEMINI_API_KEY in Cloudflare Pages → Settings → Environment variables.
// The browser-side GEMINI_API_KEY build variable can be left empty once this
// proxy is in place (the Live API WebSocket still needs it — see geminiService.ts).

interface Env {
  GEMINI_API_KEY: string;
}

export const onRequest: PagesFunction<Env> = async ({ request, params, env }) => {
  const pathSegments = (params.path as string | string[]);
  const path = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;

  const originalUrl = new URL(request.url);
  const targetUrl = new URL(`https://generativelanguage.googleapis.com/${path}`);

  // Copy through any query params from the original request (e.g. alt=sse)
  originalUrl.searchParams.forEach((v, k) => targetUrl.searchParams.set(k, v));

  // Inject the server-side API key
  targetUrl.searchParams.set('key', env.GEMINI_API_KEY);

  return fetch(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
  });
};
