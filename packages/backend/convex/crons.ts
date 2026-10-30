import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("reconcile builds", { minutes: 1 }, internal.orchestrator.reconcile, {});
crons.interval("reconcile saves", { minutes: 1 }, internal.saves.reconcile, {});
crons.interval("clean up artifacts", { minutes: 15 }, internal.maintenance.cleanup, {});
crons.interval("prune GitHub connect states", { hours: 1 }, internal.githubStorage.pruneConnectStates, {});
crons.interval("prune auth attempt counters", { hours: 6 }, internal.authGate.pruneAttempts, {});

export default crons;
