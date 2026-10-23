import { createClient } from 'npm:@supabase/supabase-js@2.99.0'
import { createPoEmailHandler } from './handler.ts'

// verify_jwt=false allows current publishable keys; getUser(token) verifies the
// actual user JWT with Supabase Auth, while begin_po_dispatch enforces HQ access.
Deno.serve(createPoEmailHandler({
  env: name => Deno.env.get(name),
  createUserClient(url, anonKey, token) {
    const client = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } })
    return {
      async getUser() { const result = await client.auth.getUser(token); return { data: result.data.user ? { id: result.data.user.id } : null, error: result.error } },
      async getDispatch(id) { return await client.from('po_dispatches').select('*').eq('id', id).maybeSingle() },
      async getAttachment(id) { return await client.from('attachments').select('id,style_id,path,name,mime,size').eq('id', id).maybeSingle() },
      async downloadAttachment(path) { return await client.storage.from('sig-files').download(path) },
      async beginDispatch(id, expectedVersion) { return await client.rpc('begin_po_dispatch', { p_id: id, p_expected_version: expectedVersion }) },
    }
  },
  createServiceClient(url, serviceRoleKey) {
    const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
    return { async finalizeDispatch(input) { return await client.rpc('finalize_po_dispatch', { p_id: input.id, p_provider_message_id: input.providerMessageId, p_error: input.error, p_outcome: input.outcome }) } }
  },
}))
