import { createClient } from 'npm:@supabase/supabase-js@2.99.0'
import { loadPoProjectContext } from '../_shared/po-project-policy.ts'
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
      async getProjectContext(poId, styleId) {
        try {
          const data = await loadPoProjectContext({
            async linkedRuns(id, style) { return await client.from('production_runs').select('project_id,project_code,snapshot').eq('po_id', id).eq('style_id', style) },
            async capturedContext(id, style) { return await client.from('po_production_contexts').select('snapshot').eq('po_id', id).eq('style_id', style).maybeSingle() },
            async style(id) { return await client.from('styles').select('data').eq('id', id).maybeSingle() },
            async project(id) { return await client.from('projects').select('id,name,code,season').eq('id', id).maybeSingle() },
            async productionName(id) {
              const result = await client.rpc('get_production_project_names', { p_project_id: id })
              if (result.error && ['PGRST202', '42883'].includes(result.error.code)) return { data: null, error: null }
              if (result.error) return { data: null, error: result.error }
              return { data: (result.data || []).find((row: { projectId: string }) => row.projectId === id) || null, error: null }
            },
            async orderSources(id) {
              const rows = []
              for (let from = 0;; from += 500) {
                const result = await client.from('order_source_records').select('rows_data').eq('style_id', id).order('line_id').range(from, from + 499)
                if (result.error) return { data: null, error: result.error }
                rows.push(...(result.data || []))
                if ((result.data || []).length < 500) return { data: rows, error: null }
              }
            },
          }, poId, styleId)
          return { data, error: null }
        } catch { return { data: null, error: { code: 'PO_PROJECT_LOOKUP_UNAVAILABLE' } } }
      },
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
