// Keys of the composer's session-scoped top rows. The rows are siblings of one
// fragment, so each needs a key of its own: siblings sharing a key make React
// lose one of them when the session (and with it the key) changes, and that
// row's DOM then stays on screen, frozen, in every session until a reload.

/** Remounts the background-commands row on a session switch. */
export const backgroundShellsRowKey = (sessionId: string | null | undefined): string => `background-shells:${sessionId ?? ''}`;

/** Remounts the background-subtasks row on a session switch. */
export const backgroundSubtasksRowKey = (sessionId: string | null | undefined): string => `background-subtasks:${sessionId ?? ''}`;
