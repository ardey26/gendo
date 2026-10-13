import type { Route } from "../route.ts";
export default function OwnerApp({ route }: { route: Route; network: "Preprod" | "Custom" }) {
  return <div className="app" data-ready><main style={{ padding: 20 }}>{route.page === "missing" ? "Not found" : "Owner app"}</main></div>;
}
