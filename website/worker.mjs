export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);
    if (url.pathname === '/install.md' && response.ok) {
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'text/markdown; charset=utf-8');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
