import type { Profile, Workspace } from './types'
import { buildBudgetSources } from './budget-domain'

/** The FA portal receives financial projections, never the production workspace. */
export function financeOnlyWorkspace(workspace: Workspace, supplied: Profile): Workspace {
  const actor = workspace.profiles.find(person => person.id === supplied.id)
  const allowed = actor?.role === 'finance' && actor.approved && actor.active && !actor.withdrawnAt
  return {
    profiles: actor ? [{ ...actor }] : [], styles: [], factories: [], projects: [], comments: [], attachments: [], audits: [],
    budgetSources: allowed ? workspace.budgetSources || buildBudgetSources(workspace) : { orders: [], settlements: [], warnings: [] },
    budgetRecords: allowed ? workspace.budgetRecords || [] : [],
    budgetAudits: allowed ? workspace.budgetAudits || [] : [],
    budgetAvailable: allowed && workspace.budgetAvailable === true,
    financeRoleAvailable: workspace.financeRoleAvailable,
  }
}
