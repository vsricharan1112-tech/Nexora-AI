import 'jsr:@supabase/functions-js/edge-runtime.d.ts'

const json = (status: number, value: Record<string, unknown>) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })

  const authorization = request.headers.get('authorization') || ''
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i)
  if (!match) return json(401, { error: 'Sign in to delete your account.' })

  const projectUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/$/, '')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!projectUrl || !anonKey || !serviceRoleKey) {
    console.error('delete-account is missing required Supabase runtime configuration.')
    return json(503, { error: 'Account deletion is temporarily unavailable.' })
  }

  let userResponse: Response
  try {
    userResponse = await fetch(projectUrl + '/auth/v1/user', {
      headers: { apikey: anonKey, authorization: 'Bearer ' + match[1] },
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return json(502, { error: 'Could not verify this account. Please retry.' })
  }
  if (!userResponse.ok) return json(401, { error: 'Your session expired. Sign in again and retry.' })

  const user = await userResponse.json().catch(() => ({}))
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user?.id || '')) {
    return json(401, { error: 'Could not verify this account. Please sign in again.' })
  }

  let deleteResponse: Response
  try {
    deleteResponse = await fetch(projectUrl + '/auth/v1/admin/users/' + encodeURIComponent(user.id), {
      method: 'DELETE',
      headers: { apikey: serviceRoleKey, authorization: 'Bearer ' + serviceRoleKey },
      signal: AbortSignal.timeout(10000),
    })
  } catch {
    return json(502, { error: 'Could not delete this account. Please retry.' })
  }
  if (!deleteResponse.ok) {
    console.error('Supabase Auth account deletion returned:', deleteResponse.status)
    return json(502, { error: 'Could not delete this account. Please retry.' })
  }

  return json(200, { ok: true })
})

