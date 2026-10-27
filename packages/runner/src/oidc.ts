import { z } from "zod";
import { requestJson, type FetchLike } from "./http";

const tokenResponse = z.object({ value: z.string().min(20) });

/** Requests a GitHub Actions OIDC token for the LinxGen audience. Requires `id-token: write`. */
export async function fetchOidcToken(fetchImpl: FetchLike, requestUrl: string, requestToken: string, audience: string) {
  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);
  const body = await requestJson(fetchImpl, url.toString(), { method: "GET", token: requestToken, schema: tokenResponse });
  return body.value;
}
