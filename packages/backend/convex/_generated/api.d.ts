/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as artifacts from "../artifacts.js";
import type * as auth from "../auth.js";
import type * as authGate from "../authGate.js";
import type * as builds from "../builds.js";
import type * as crons from "../crons.js";
import type * as generation from "../generation.js";
import type * as githubStorage from "../githubStorage.js";
import type * as http from "../http.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_attempts from "../lib/attempts.js";
import type * as lib_buildOps from "../lib/buildOps.js";
import type * as lib_config from "../lib/config.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_generationLoop from "../lib/generationLoop.js";
import type * as lib_github from "../lib/github.js";
import type * as lib_githubStorage from "../lib/githubStorage.js";
import type * as lib_invites from "../lib/invites.js";
import type * as lib_objectStorage from "../lib/objectStorage.js";
import type * as lib_oidc from "../lib/oidc.js";
import type * as lib_packages from "../lib/packages.js";
import type * as lib_providers from "../lib/providers.js";
import type * as lib_saves from "../lib/saves.js";
import type * as lib_scheduling from "../lib/scheduling.js";
import type * as lib_settings from "../lib/settings.js";
import type * as lib_setupChecks from "../lib/setupChecks.js";
import type * as lib_storageBudget from "../lib/storageBudget.js";
import type * as maintenance from "../maintenance.js";
import type * as orchestrator from "../orchestrator.js";
import type * as profiles from "../profiles.js";
import type * as providers from "../providers.js";
import type * as runner from "../runner.js";
import type * as saves from "../saves.js";
import type * as setup from "../setup.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  artifacts: typeof artifacts;
  auth: typeof auth;
  authGate: typeof authGate;
  builds: typeof builds;
  crons: typeof crons;
  generation: typeof generation;
  githubStorage: typeof githubStorage;
  http: typeof http;
  "lib/access": typeof lib_access;
  "lib/attempts": typeof lib_attempts;
  "lib/buildOps": typeof lib_buildOps;
  "lib/config": typeof lib_config;
  "lib/crypto": typeof lib_crypto;
  "lib/generationLoop": typeof lib_generationLoop;
  "lib/github": typeof lib_github;
  "lib/githubStorage": typeof lib_githubStorage;
  "lib/invites": typeof lib_invites;
  "lib/objectStorage": typeof lib_objectStorage;
  "lib/oidc": typeof lib_oidc;
  "lib/packages": typeof lib_packages;
  "lib/providers": typeof lib_providers;
  "lib/saves": typeof lib_saves;
  "lib/scheduling": typeof lib_scheduling;
  "lib/settings": typeof lib_settings;
  "lib/setupChecks": typeof lib_setupChecks;
  "lib/storageBudget": typeof lib_storageBudget;
  maintenance: typeof maintenance;
  orchestrator: typeof orchestrator;
  profiles: typeof profiles;
  providers: typeof providers;
  runner: typeof runner;
  saves: typeof saves;
  setup: typeof setup;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
