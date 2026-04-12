// Cloudflare Pages Function — proxies Firebase's auth handler onto this domain.
//
// Firebase's signInWithRedirect sends the OAuth redirect_uri to whatever
// `authDomain` is set to. By setting authDomain = this domain and proxying
// /__/auth/* to the real Firebase handler, the entire auth redirect chain
// stays on the Cloudflare domain. iOS then opens the final redirect inside
// the installed PWA WebView instead of in Safari, so the auth result lands
// in the correct browsing context.

export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  const target = `https://smarthandla.firebaseapp.com${url.pathname}${url.search}`;

  const response = await fetch(target, {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null,
    redirect: 'manual',
  });

  // Cloudflare returns opaque redirects that the browser cannot follow.
  // Re-emit them as explicit redirects so the browser handles them correctly.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('Location');
    if (location) {
      return new Response(null, {
        status: response.status,
        headers: { Location: location },
      });
    }
  }

  return response;
};
