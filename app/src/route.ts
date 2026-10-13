// Path routes for the whole app; the owner app navigates with history.pushState.
export type Route =
  | { page: "public"; policy: string }
  | { page: "start" }
  | { page: "inbox" }
  | { page: "vault"; policy: string; tab: "agents" | "activity" | "treasury" | "settings" }
  | { page: "agent"; policy: string; unit?: string }
  | { page: "missing" };

const POLICY = "([0-9a-f]{56})";
export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, "") || "/";
  let m;
  if ((m = new RegExp(`^/w/${POLICY}$`).exec(p))) return { page: "public", policy: m[1]! };
  if (p === "/") return { page: "start" };
  if (p === "/inbox") return { page: "inbox" };
  if ((m = new RegExp(`^/v/${POLICY}(?:/(agents|activity|treasury|settings))?$`).exec(p)))
    return { page: "vault", policy: m[1]!, tab: (m[2] as "agents" | "activity" | "treasury" | "settings") ?? "agents" };
  if ((m = new RegExp(`^/v/${POLICY}/agents/new$`).exec(p))) return { page: "agent", policy: m[1]! };
  if ((m = new RegExp(`^/v/${POLICY}/agents/([0-9a-f]{58,120})$`).exec(p)) && m[2]!.startsWith(m[1]!)) return { page: "agent", policy: m[1]!, unit: m[2]! };
  return { page: "missing" };
}

export function navigate(to: string) {
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}
