// Strict Bearer auth for ws upgrade. Accepts the token via either:
//   Authorization: Bearer <token>
//   Sec-WebSocket-Protocol: <token>   (exact entry, not substring)
// `checkBearer(req, bearer)` returns true if the request is authorized.
// `pickProtocolFor(bearer)` returns a handleProtocols function that echoes
// the bearer when offered as a subprotocol.

export function checkBearer(req, bearer) {
  if (!bearer) return true;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${bearer}`) return true;
  const proto = req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    const tokens = proto.split(',').map(s => s.trim());
    if (tokens.includes(bearer)) return true;
  }
  return false;
}

export function pickProtocolFor(bearer) {
  return (protocols) => {
    if (!bearer) return false;
    const list = Array.isArray(protocols) ? protocols : [...protocols];
    return list.includes(bearer) ? bearer : false;
  };
}
