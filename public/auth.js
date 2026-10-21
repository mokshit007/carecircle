// Sign-in for the dashboard and simulator when CareCircle runs with ALLOW_ANONYMOUS=false.
// Adds the saved access code to every /api request, and asks for one when the server says 401.
(() => {
  const KEY = 'carecircle_access_code';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* private mode */ } };
  const original = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return original(input, init);
    const withAuth = () => {
      const code = read();
      const headers = new Headers(init.headers || {});
      if (code) headers.set('Authorization', `Bearer ${code}`);
      return original(input, { ...init, headers });
    };
    let res = await withAuth();
    if (res.status === 401) {
      const code = window.prompt('Enter your CareCircle access code');
      if (code) { write(code.trim()); res = await withAuth(); }
    }
    return res;
  };

  // EventSource can't send headers, so the code goes in the query string for the live-updates stream only.
  window.ccEventSource = (url) => {
    const code = read();
    return new EventSource(code ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(code)}` : url);
  };
  window.ccSignOut = () => { write(null); location.reload(); };
})();
