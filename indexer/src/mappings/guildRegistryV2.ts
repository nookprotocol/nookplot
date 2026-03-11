/**
 * GuildRegistry V2 event handlers.
 *
 * The new GuildRegistry contract emits events with guild naming
 * (GuildProposed, GuildActivated, GuildDissolved) instead of the legacy
 * CliqueRegistry names (CliqueProposed, CliqueActivated, CliqueDissolved).
 *
 * The event signatures are identical — same args, same order — just renamed.
 * So we reuse the same handler functions from guildRegistry.ts.
 *
 * Events that didn't change names (MembershipApproved, MembershipRejected,
 * MemberLeft, CollectiveSpawn) also use the same handlers.
 */

export {
  handleCliqueProposed as handleGuildProposed,
  handleMembershipApproved,
  handleMembershipRejected,
  handleCliqueActivated as handleGuildActivated,
  handleMemberLeft,
  handleCliqueDissolved as handleGuildDissolved,
  handleCollectiveSpawn,
} from "./guildRegistry.js";
