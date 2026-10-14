import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseRoute } from "./route.ts";
import "./ui/gendo.css";
import { Spinner } from "./ui/Brand.tsx";
import { Notice } from "./ui/Notice.tsx";

// A tab older than the files kept after a deploy: reload once onto the current build.
addEventListener("vite:preloadError", () => {
  try {
    const last = Number(sessionStorage.getItem("gendo.reloadedAt") ?? 0);
    if (Date.now() - last < 60_000) return; // just reloaded: don't loop
    sessionStorage.setItem("gendo.reloadedAt", String(Date.now()));
  } catch {
    // no storage: one reload is still better than a dead page
  }
  location.reload();
});

const network = (import.meta.env.VITE_NETWORK ?? "Preprod") as "Preprod" | "Custom";
const PublicPage = lazy(() => import("./public/PublicPage.tsx").then((m) => ({ default: m.PublicPage })));
// Owner routes need Lucid: the Buffer polyfill must run before any of it loads.
const OwnerApp = lazy(async () => {
  await import("./owner/polyfill.ts");
  return import("./owner/OwnerApp.tsx");
});

function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const route = parseRoute(path);
  return (
    <Suspense fallback={<div className="app"><div className="boot"><Spinner label="Loading…" /></div></div>}>
      {route.page === "public" ? <PublicPage policy={route.policy} network={network} /> : <OwnerApp route={route} network={network} />}
      <Notice />
    </Suspense>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
