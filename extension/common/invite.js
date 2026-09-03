/**
 * Invite string: the one-paste form of a server connection.
 *
 *   zensync://<host>[:<port>][/<path>]/?t=<token>[&n=<device name>][&s=0]
 *
 * The scheme is a container, not a transport: wss:// is implied, and `s=0`
 * marks a plaintext ws:// deployment (localhost / trusted LAN). Raw
 * ws(s):// URLs are also accepted so an invite can carry a full URL, and
 * the token may ride in the fragment instead of the query.
 */

export function parseInvite(raw) {
  const text = (raw || '').trim();
  if (!text) return null;

  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (!['zensync', 'ws', 'wss'].includes(scheme)) return null;
  if (!url.host) return null;

  // Token: ?t= / ?token= / #<token>
  const params = url.searchParams;
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const token = (params.get('t') || params.get('token') || fragment || '').trim();
  if (!token) return null;

  let serverUrl;
  if (scheme === 'ws' || scheme === 'wss') {
    // A full URL was pasted — keep it, minus the credential bits.
    url.hash = '';
    params.delete('t');
    params.delete('token');
    params.delete('n');
    params.delete('s');
    serverUrl = url.toString().replace(/\?$/, '');
  } else {
    const secure = params.get('s') !== '0';
    const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
    serverUrl = `${secure ? 'wss' : 'ws'}://${url.host}${path}`;
  }

  const deviceName = (params.get('n') || '').trim();
  return { serverUrl, token, deviceName: deviceName || null };
}

/**
 * Rebuilds an invite from stored config, so a configured device can hand
 * the next one a single string (no server access needed).
 */
export function buildInvite({ serverUrl, token }) {
  if (!serverUrl || !token) return null;
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  const secure = url.protocol === 'wss:';
  const path = url.pathname && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '';
  const params = new URLSearchParams({ t: token });
  if (!secure) params.set('s', '0');
  return `zensync://${url.host}${path}/?${params.toString()}`;
}
