import { internalAction } from "./_generated/server";
import { verifySetup } from "./lib/setupChecks";

/**
 * Reports whether the deployment is configured, without returning or logging secret values:
 *   npx convex run setup:verify
 */
export const verify = internalAction({
  args: {},
  handler: async () => verifySetup(),
});
