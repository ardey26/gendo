// app/src/main.tsx
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { parsePolicy } from "./public/format.ts";

const PublicPage = lazy(() => import("./public/PublicPage.tsx").then((m) => ({ default: m.PublicPage })));
const network = (import.meta.env.VITE_NETWORK ?? "Preprod") as "Preprod" | "Custom";
const policy = parsePolicy(location.pathname);

createRoot(document.getElementById("root")!).render(
  policy ? (
    <Suspense fallback={<p>Loading…</p>}><PublicPage policy={policy} network={network} /></Suspense>
  ) : location.pathname.startsWith("/w/") ? (
    <main data-ready><h1>No vault found</h1><p>That isn't a vault id.</p></main>
  ) : (
    <main><h1>gendo</h1><p>Open a vault's public page at /w/&lt;vault policy id&gt; (vault info prints it).</p></main>
  ),
);
