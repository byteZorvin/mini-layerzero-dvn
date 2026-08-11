export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

export function methodNotAllowed(allowed: string): Response {
  return new Response("Method not allowed", { status: 405, headers: { allow: allowed } });
}

export function isAuthorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const actual = new TextEncoder().encode(value.slice(7));
  const wanted = new TextEncoder().encode(expected);
  if (actual.length !== wanted.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ wanted[index];
  return difference === 0;
}
