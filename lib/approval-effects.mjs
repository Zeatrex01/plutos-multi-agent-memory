// What happens in the project when the owner approves a ticket that carries an action.
//
// The dashboard's POST /api/approvals and the CLI's `plutos approve` both call one function here,
// so an effect runs the same way from either surface. Every effect runs through runApprovedAction:
// the ticket's seals must hold, its tier must allow where the answer came from, and the result is
// recorded in the ticket, so a retry returns the recorded outcome instead of running twice.
//
// No action kind exists today. The only one there was, `profile_full` (the casting for the full
// profile), was cut on 2026-11-04 with profiles and system roles. A ticket from before then still
// lists, answers and settles; approving it applies nothing, and this function says so with null.

// → the action result ({status, detail}) or null when the ticket carries no action, carries an
// action nothing applies any more, or was not approved. Throws on a failed effect so the caller
// can report it next to the answer.
export function applyApprovedSideEffects(projectRoot, ticket) {
    if (ticket?.status !== 'approved' || !ticket.action) return null;
    return null;
}
