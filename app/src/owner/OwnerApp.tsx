import { useCallback, useEffect, useState } from "react";
import type { LucidEvolution } from "../../../sdk/src/core/index.ts";
import type { Route } from "../route.ts";
import { Netband, Spinner } from "../ui/Brand.tsx";
import { SERVER_DOWN, api, session, type MyVault } from "./api.ts";
import { openChain, readThroughSession } from "./chain.ts";
import { consistentVaults } from "./vaults.ts";
import { AgentEditor } from "./pages/AgentEditor.tsx";
import { ConnectAgent } from "./pages/Connect.tsx";
import { Create } from "./pages/Create.tsx";
import { Inbox } from "./pages/Inbox.tsx";
import { Connect, Start } from "./pages/Start.tsx";
import { VaultPage } from "./pages/Vault.tsx";
import type { Net } from "./types.ts";
import { OwnerCtx, type Owner } from "./ui.tsx";
import { connectWallet, type Connected } from "./wallet.ts";

export default function OwnerApp({ route, network }: { route: Route; network: Net }) {
  const [lucid, setLucid] = useState<LucidEvolution>();
  const [fatal, setFatal] = useState<string>();
  const [me, setMe] = useState<Connected>();
  const [vaults, setVaults] = useState<MyVault[]>([]);
  const [inboxCount, setInboxCount] = useState(0);
  const [down, setDown] = useState(false);

  useEffect(() => {
    openChain(network)
      .then(async (l) => {
        if (import.meta.env.VITE_TEST_WALLETS === "1") (await import("./testwallet.ts")).installTestWallet(l);
        setLucid(l);
      })
      // /chain is on our server: if it can't be reached at all, say so with the CLI fallback.
      .catch((e) => setFatal(e instanceof TypeError ? SERVER_DOWN : "The chain is unavailable right now. Try again in a minute."));
  }, [network]);

  // A session in this tab: reconnect the same wallet quietly.
  useEffect(() => {
    const s = session.get();
    if (!lucid || !s || me) return;
    connectWallet(s.walletId)
      .then((c) => (c.pkh === s.pkh ? setMe(c) : session.clear()))
      .catch(() => session.clear());
  }, [lucid]);

  useEffect(() => {
    if (!lucid || !me) return;
    readThroughSession(lucid);
    lucid.selectWallet.fromAPI(me.api as never);
  }, [lucid, me]);

  useEffect(() => {
    const on = () => setDown(true);
    addEventListener("gendo:server-down", on);
    return () => removeEventListener("gendo:server-down", on);
  }, []);

  const reloadVaults = useCallback(async () => {
    try {
      setVaults(consistentVaults(await api.myVaults()));
      setDown(false);
    } catch (e) {
      if ((e as Error).message === SERVER_DOWN) setDown(true);
    }
  }, []);
  const reloadInbox = useCallback(async () => {
    try {
      const rows = await api.myPending();
      setInboxCount(rows.filter((p) => p.status === "open" && p.requiredSigners.includes(me?.pkh ?? "") && !p.signedBy.includes(me?.pkh ?? "")).length);
    } catch {
      // the banner covers a down server
    }
  }, [me]);
  useEffect(() => {
    if (!me) return;
    void reloadVaults();
    void reloadInbox();
    const t = setInterval(() => void reloadInbox(), 30_000);
    return () => clearInterval(t);
  }, [me]);

  if (fatal) return <div className="app" data-error><Netband /><p style={{ padding: 20 }}>{fatal}</p></div>;
  if (!lucid) return <div className="app"><Netband /><div className="boot"><Spinner label="Connecting to the chain…" /></div></div>;
  if (!me) return <Connect onConnected={setMe} />;
  const ctx: Owner = {
    net: network, lucid, me, vaults, reloadVaults, inboxCount, reloadInbox,
    signOut: () => {
      session.clear();
      setMe(undefined);
    },
  };
  return (
    <OwnerCtx.Provider value={ctx}>
      {down && (
        <div className="err" role="alert" style={{ background: "#15120f", border: "1px dashed #4a2a24" }}>
          <span style={{ fontWeight: 700 }}>{SERVER_DOWN}</span>
          <button type="button" className="btn" onClick={() => void reloadVaults()}>Retry</button>
        </div>
      )}
      {route.page === "start" && <Start />}
      {route.page === "inbox" && <Inbox />}
      {route.page === "create" && <Create />}
      {route.page === "connect" && <ConnectAgent policy={route.policy} />}
      {route.page === "vault" && <VaultPage policy={route.policy} tab={route.tab} />}
      {route.page === "agent" && <AgentEditor policy={route.policy} {...(route.unit ? { unit: route.unit } : {})} />}
      {route.page === "missing" && <div className="app" data-ready><p style={{ padding: 20 }}>Not found.</p></div>}
    </OwnerCtx.Provider>
  );
}
